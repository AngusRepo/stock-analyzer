import type { Bindings } from '../types'
import type { EvidenceArtifactManifest } from './evidenceArtifactContract'
import { writeEvidenceArtifact, retainArtifactHardReference } from './artifactLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'

export const REPLAY_COMPACT_SCHEMA = 's12-replay-compact-v1'
export const REPLAY_COMPACT_DOMAIN = 'retention_s12_replay_compact_v1'
export type ReplayScalarRow = Record<string, any>
export const REPLAY_PROJECTED_COLUMNS = ['id','symbol','signal_date','trade_date','setup_id','market','assessment_state','entry_ms',
  'entry_price','stop_price','pnl_pct','max_favorable_pct','max_adverse_pct','sample_eligible','source','detail_json'] as const
export const REPLAY_PRODUCER_COLUMNS = ['symbol','market','signal_date','trade_date','assessment_state','setup_id',
  'entry_ms','exit_ms','entry_price','stop_price','target1_price','target2_price','target3_price','exit_price',
  'pnl_pct','trade_pnl_r','max_favorable_pct','max_adverse_pct','bars_to_exit','exit_reason','sample_eligible','source','detail_json'] as const
const DETAIL_FIELDS = ['assessment_detail','assessmentDetail','assessment_state','market_segment','alpha_bucket',
  'schema_version','observation_kind'] as const

export function projectReplayRow(row: ReplayScalarRow): ReplayScalarRow {
  const original = row.detail_json == null ? null : JSON.parse(row.detail_json)
  const detail: ReplayScalarRow = Object.fromEntries(DETAIL_FIELDS.map(k => [k, original?.[k] ?? null]))
  detail.replay_diagnostics = Object.fromEntries(['replay_engine_signature','replay_cohort_signature','outcome_known_date']
    .map(k => [k, original?.replay_diagnostics?.[k] ?? null]))
  return Object.fromEntries(REPLAY_PROJECTED_COLUMNS.map(c => [c, c === 'detail_json' ? JSON.stringify(detail) : row[c] ?? null]))
}

/** Only fields read by replay completion/repair queries; preserve JSON scalar types. */
export function replayStatusJson(row: ReplayScalarRow): string {
  const d = row.detail_json == null ? null : JSON.parse(row.detail_json)
  return JSON.stringify({observation_kind:d?.observation_kind ?? null,status_reason:d?.status_reason ?? null,
    lineage_validation:{previous_sample_eligible:d?.lineage_validation?.previous_sample_eligible ?? null,
      status:d?.lineage_validation?.status ?? null},
    replay_diagnostics:Object.fromEntries(['replay_engine_signature','entry_policy_signature','exit_calibration_signature',
      'replay_cohort_signature','outcome_known_date'].map(k => [k,d?.replay_diagnostics?.[k] ?? null]))})
}

export async function replayRowChecksum(row: ReplayScalarRow): Promise<string> {
  return sha256Text(JSON.stringify(Object.entries(row).filter(([k]) => !['__cursor_key','__archive_date'].includes(k))
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)))
}

/** Exact persisted producer values; id/created_at are assigned by the database. */
export async function replayProducerChecksum(row: ReplayScalarRow): Promise<string> {
  return sha256Text(JSON.stringify(REPLAY_PRODUCER_COLUMNS.map(k => row[k] ?? null)))
}

export type ReplayReleaseProjection = {
  source_artifact_id: string
  source_checksum: string
  rows_checksum: string
  projection: EvidenceArtifactManifest
}

export async function buildReplayCompactPayload(rows: ReplayScalarRow[], source: {artifact_id:string;checksum:string}) {
  return {
    schema_version: REPLAY_COMPACT_SCHEMA,
    source_artifact_id: source.artifact_id,
    source_checksum: source.checksum,
    rows_checksum: await sha256Text(JSON.stringify(rows)),
    rows: await Promise.all(rows.map(async row => ({...projectReplayRow(row), row_checksum: await replayRowChecksum(row)}))),
  }
}

/** Full raw evidence remains immutable; this sidecar only serves the defined Worker projection. */
export async function prepareReplayReleaseProjection(env: Bindings, rows: ReplayScalarRow[], source: EvidenceArtifactManifest)
  : Promise<ReplayReleaseProjection> {
  const payload = await buildReplayCompactPayload(rows, source)
  const projection = await writeEvidenceArtifact(env, {
    domain: REPLAY_COMPACT_DOMAIN, businessDate: source.business_date,
    producerRunId: source.producer_run_id + ':compact', retentionClass: 'ten_year_cold_archive',
    schemaVersion: REPLAY_COMPACT_SCHEMA, payload, rowCount: rows.length, createdAt: source.created_at,
    metadata: {source_artifact_id:source.artifact_id,source_checksum:source.checksum},
  })
  // Keep BOTH copies while the Learning release/derived tables depend on them.
  // A separate verified expiry workflow must release these references after retirement.
  const ops = databaseForDataDomain(env, 'ops')
  for (const artifactId of [source.artifact_id, projection.artifact_id]) {
    await retainArtifactHardReference(ops, {artifactId,ownerType:'s12_replay_release',ownerId:source.artifact_id})
  }
  return {source_artifact_id:source.artifact_id,source_checksum:source.checksum,rows_checksum:payload.rows_checksum,projection}
}
