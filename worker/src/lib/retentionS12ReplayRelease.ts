import type { ReplayReleaseProjection, ReplayScalarRow } from './retentionS12ReplayProjection'
import { REPLAY_COMPACT_DOMAIN, REPLAY_COMPACT_SCHEMA, replayRowChecksum, replayProducerChecksum, replayStatusJson } from './retentionS12ReplayProjection'
import { sha256Text } from './datasetSnapshots'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'

export async function assertReplayReleaseProjection(rows: ReplayScalarRow[], source: {artifact_id:string;checksum:string},
  compact?: ReplayReleaseProjection): Promise<ReplayReleaseProjection> {
  const p = compact?.projection
  if (!compact || !p || compact.source_artifact_id !== source.artifact_id || compact.source_checksum !== source.checksum
    || compact.rows_checksum !== await sha256Text(JSON.stringify(rows)) || p.row_count !== rows.length
    || p.schema_version !== REPLAY_COMPACT_SCHEMA || p.domain !== REPLAY_COMPACT_DOMAIN
    || p.status !== 'ready' || p.retention_class !== 'ten_year_cold_archive' || !p.checksum_verified_at
    || !p.r2_key || !/^sha256:[0-9a-f]{64}$/.test(p.checksum)
    || !Number.isSafeInteger(p.byte_size) || p.byte_size <= 0 || p.byte_size > 7 * 1024 * 1024)
    throw new Error('retention_s12_replay_projection_required_or_mismatched')
  return compact
}

export async function assertSavedReplayRelease(db: D1Database, source: {artifact_id:string;checksum:string},
  compact: ReplayReleaseProjection): Promise<void> {
  const saved = await db.prepare('SELECT * FROM s12_replay_cold_batches_v1 WHERE artifact_id=?')
    .bind(source.artifact_id).first<Record<string, any>>()
  const p = compact.projection
  if (!saved || saved.source_checksum !== source.checksum || saved.row_count !== p.row_count
    || saved.rows_checksum !== compact.rows_checksum || saved.projection_artifact_id !== p.artifact_id
    || saved.projection_key !== p.r2_key || saved.projection_checksum !== p.checksum || saved.projection_bytes !== p.byte_size
    || saved.cost_bps !== CANONICAL_SELECTION_ROUNDTRIP_COST_BPS)
    throw new Error('retention_s12_replay_saved_projection_conflict')
}

/** Execute before the exact DELETE in the SAME D1 batch. Any failure rolls everything back. */
export async function replayReleaseStatements(db: D1Database, rows: ReplayScalarRow[], compact: ReplayReleaseProjection)
  : Promise<D1PreparedStatement[]> {
  const p = compact.projection
  const identities = await Promise.all(rows.map(async row => ({id:row.id,symbol:row.symbol,signal_date:row.signal_date,
    trade_date:row.trade_date,setup_id:row.setup_id,row_checksum:await replayRowChecksum(row),
    producer_checksum:await replayProducerChecksum(row),sample_eligible:row.sample_eligible,source:row.source,status_json:replayStatusJson(row)})))
  if (rows.some(row => row.id !== row.__cursor_key)) throw new Error('retention_s12_replay_source_identity_invalid')
  const keys = JSON.stringify(identities)
  return [
    db.prepare(`INSERT INTO s12_replay_cold_batches_v1
      (artifact_id,source_checksum,row_count,rows_checksum,projection_artifact_id,projection_key,projection_checksum,projection_bytes,cost_bps)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(compact.source_artifact_id,compact.source_checksum,rows.length,compact.rows_checksum,
      p.artifact_id,p.r2_key,p.checksum,p.byte_size,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS),
    db.prepare(`INSERT INTO s12_replay_cold_identities_v1
      (id,artifact_id,symbol,signal_date,trade_date,setup_id,row_checksum,producer_checksum,sample_eligible,source,status_json)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.symbol'),json_extract(value,'$.signal_date'),
        json_extract(value,'$.trade_date'),json_extract(value,'$.setup_id'),json_extract(value,'$.row_checksum'),
        json_extract(value,'$.producer_checksum'),json_extract(value,'$.sample_eligible'),json_extract(value,'$.source'),
        json_extract(value,'$.status_json') FROM json_each(?)`).bind(compact.source_artifact_id,keys),
    // SQLite evaluates the ORIGINAL eligibility and fee expressions on original rows, not rounded JS values.
    // Known-at is part of the grouping key: an as-of read must not see later outcomes from the same signal day.
    db.prepare(`INSERT INTO s12_replay_cold_rewards_v1
      (artifact_id,signal_date,outcome_known_date,engine_signature,samples,hits,reward_sum)
      SELECT ?,o.signal_date,date(json_extract(o.detail_json,'$.replay_diagnostics.outcome_known_date')),
        json_extract(o.detail_json,'$.replay_diagnostics.replay_engine_signature'),COUNT(*),
        SUM(CASE WHEN CAST(o.pnl_pct AS REAL)-(?/10000.0)>0 THEN 1 ELSE 0 END),
        SUM(CAST(o.pnl_pct AS REAL)-(?/10000.0))
      FROM s12_replay_trade_outcomes o JOIN json_each(?) j ON o.id=json_extract(j.value,'$.id')
      WHERE o.signal_date IS NOT NULL AND date(o.signal_date) IS NOT NULL
        AND o.sample_eligible=1 AND o.source='s12_multisession_structure_replay_v3' AND o.pnl_pct IS NOT NULL
        AND json_extract(o.detail_json,'$.schema_version')='s12-replay-trade-outcome-v3'
        AND json_extract(o.detail_json,'$.observation_kind')='executed'
        AND json_extract(o.detail_json,'$.replay_diagnostics.replay_engine_signature') IS NOT NULL
        AND date(json_extract(o.detail_json,'$.replay_diagnostics.outcome_known_date')) IS NOT NULL
      GROUP BY o.signal_date,date(json_extract(o.detail_json,'$.replay_diagnostics.outcome_known_date')),
        json_extract(o.detail_json,'$.replay_diagnostics.replay_engine_signature')`)
      .bind(compact.source_artifact_id,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,keys),
  ]
}

/** Called ONLY after the DB's archived-key trigger rejects a write. The normal hot path has no extra RPC. */
export async function acknowledgeArchivedReplayRetry(db: D1Database, row: ReplayScalarRow,
  expectedLifecycleRunId: string | null): Promise<boolean> {
  const matches = (await db.prepare(`SELECT c.producer_checksum,
    (? IS NULL OR EXISTS(SELECT 1 FROM allocator_ev_daily_lifecycle l WHERE l.business_date=? AND l.upstream_run_id=?)) AS authorized
    FROM s12_replay_cold_identities_v1 c
    JOIN s12_replay_cold_batches_v1 b ON b.artifact_id=c.artifact_id
    JOIN learning_retention_releases_v1 r ON r.artifact_id=b.artifact_id AND r.checksum=b.source_checksum
      AND r.row_count=b.row_count AND r.dataset_id='s12_replay_trade_outcomes'
    WHERE c.symbol=? AND c.setup_id=? AND (c.trade_date=? OR c.signal_date=?)`)
    .bind(expectedLifecycleRunId,row.signal_date,expectedLifecycleRunId,row.symbol,row.setup_id,row.trade_date,row.signal_date)
    .all<{producer_checksum:string;authorized:number}>()).results ?? []
  if (matches.length === 1 && !matches[0].authorized) return false
  if (matches.length !== 1 || matches[0].producer_checksum !== await replayProducerChecksum(row))
    throw new Error('retention_s12_replay_archived_revision_requires_rebuild')
  return true
}
