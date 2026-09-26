import { projectReplayRow, replayRowChecksum, REPLAY_PROJECTED_COLUMNS, REPLAY_COMPACT_SCHEMA, REPLAY_COMPACT_DOMAIN } from './retentionS12ReplayProjection'
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'

export type ReplayArchiveEnv = Pick<Bindings, 'DB'> & Partial<Bindings>
export type ReplayRow = Record<string, any>
const TABLE = 's12_replay_trade_outcomes'
const DOMAIN = 'retention_learning_lineage_v1_' + TABLE
const SCHEMA = 'd1-retention-hot-window-drain-v1'
// A synchronous Worker read must never silently truncate history or exhaust its heap.
// A larger history needs a detached, resumable reader before release can be enabled.
export const REPLAY_READ_BUDGET = { bytes: 32 * 1024 * 1024, manifests: 256, rows: 50_000 } as const
const encoder = new TextEncoder()

export function replayIdentityKeys(r: ReplayRow): string[] {
  const keys = [JSON.stringify(['id', r.id])]
  if (r.setup_id != null) {
    keys.push(JSON.stringify(['trade', r.symbol, r.trade_date, r.setup_id]))
    if (r.signal_date != null) keys.push(JSON.stringify(['signal', r.symbol, r.signal_date, r.setup_id]))
  }
  return keys
}

/** Verify one archive at a time. Current hot revisions win, including another id. */
export async function* archivedS12ReplayChunks(env: ReplayArchiveEnv, learning: D1Database,
  startDate: string, endDate: string, snapshotAt: string,
  expectedRelease?: {artifactId:string;checksum:string;rowCount:number}): AsyncGenerator<ReplayRow[]> {
  if (![startDate, endDate].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) || startDate > endDate)
    throw new Error('retention_replay_request_invalid')
  const ops = databaseForDataDomain(env, 'ops'), seen = new Map<string, string>()
  let cursor = '', bytes = 0, files = 0, rowCount = 0
  while (true) {
    const manifests = (await ops.prepare(`SELECT a.artifact_id,a.domain,a.r2_key,a.checksum,a.row_count,a.byte_size,
      a.schema_version,a.metadata_json
      FROM run_artifacts a WHERE a.domain=? AND a.schema_version=? AND a.retention_class='ten_year_cold_archive'
        AND a.status='ready' AND a.payload_deleted_at IS NULL AND a.artifact_id>?
        AND datetime(a.created_at)<=datetime(?)
        ${expectedRelease ? 'AND a.artifact_id=?' : ''}
        AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')>=?
        AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')<=?
      ORDER BY a.artifact_id LIMIT 100`).bind(DOMAIN, SCHEMA, cursor, snapshotAt, ...(expectedRelease ? [expectedRelease.artifactId] : []), startDate, endDate).all<ReplayRow>()).results ?? []
    if (!manifests.length) {
      if (expectedRelease) throw new Error('retention_replay_snapshot_manifest_missing')
      return
    }
    for (const manifest of manifests) {
      cursor = manifest.artifact_id
      if (expectedRelease && (manifest.checksum !== expectedRelease.checksum || manifest.row_count !== expectedRelease.rowCount))
        throw new Error('retention_replay_snapshot_manifest_changed')
      // Learning is the authority for the sidecar AND the source release. An uncommitted sidecar is ignored.
      const compact = await learning.prepare(`SELECT b.*,r.checksum release_checksum,r.dataset_id,r.row_count released_rows
        FROM s12_replay_cold_batches_v1 b LEFT JOIN learning_retention_releases_v1 r ON r.artifact_id=b.artifact_id
        WHERE b.artifact_id=?`).bind(manifest.artifact_id).first<ReplayRow>()
      if (expectedRelease && !compact) throw new Error('retention_replay_snapshot_compact_missing')
      if (compact && (compact.source_checksum !== manifest.checksum || compact.row_count !== manifest.row_count
        || compact.release_checksum !== manifest.checksum || compact.released_rows !== manifest.row_count || compact.dataset_id !== TABLE))
        throw new Error('retention_replay_compact_release_mismatch')
      const objectBytes = compact?.projection_bytes ?? manifest.byte_size
      if (!Number.isSafeInteger(objectBytes) || objectBytes <= 0 || objectBytes > 7 * 1024 * 1024)
        throw new Error('retention_replay_archive_size_invalid')
      if (++files > REPLAY_READ_BUDGET.manifests || bytes + objectBytes > REPLAY_READ_BUDGET.bytes
        || !Number.isSafeInteger(manifest.row_count) || manifest.row_count < 1
        || rowCount + manifest.row_count > REPLAY_READ_BUDGET.rows)
        throw new Error('retention_replay_budget_exceeded:detached_reader_required')
      const object = await env.ARTIFACTS?.get(compact?.projection_key ?? manifest.r2_key)
      if (!object) throw new Error('retention_replay_archive_missing')
      if (object.size !== objectBytes) throw new Error('retention_replay_archive_size_mismatch')
      const raw = await object.text()
      if (encoder.encode(raw).length !== objectBytes || await sha256Text(raw) !== (compact?.projection_checksum ?? manifest.checksum))
        throw new Error('retention_replay_checksum_mismatch')
      bytes += objectBytes
      const body = JSON.parse(raw), payload = body.payload
      if (compact) {
        if (body.domain !== REPLAY_COMPACT_DOMAIN || body.schema_version !== REPLAY_COMPACT_SCHEMA
          || payload?.schema_version !== REPLAY_COMPACT_SCHEMA || payload.source_artifact_id !== manifest.artifact_id
          || payload.source_checksum !== manifest.checksum || payload.rows_checksum !== compact.rows_checksum
          || !Array.isArray(payload.rows) || payload.rows.length !== manifest.row_count)
          throw new Error('retention_replay_compact_payload_mismatch')
      } else if (body.domain !== DOMAIN || body.schema_version !== SCHEMA || payload?.schema_version !== SCHEMA
        || payload.dataset_id !== TABLE || payload.source_domain !== 'learning' || payload.policy_id !== 'learning_lineage_v1'
        || !Array.isArray(payload.rows) || payload.rows.length !== manifest.row_count)
        throw new Error('retention_replay_payload_mismatch')
      rowCount += payload.rows.length
      const identities = compact ? new Map(((await learning.prepare(`SELECT id,symbol,signal_date,trade_date,setup_id,row_checksum
        FROM s12_replay_cold_identities_v1 WHERE artifact_id=?`).bind(manifest.artifact_id).all<ReplayRow>()).results ?? [])
        .map(r => [r.id,r])) : null
      if (identities && identities.size !== manifest.row_count) throw new Error('retention_replay_compact_identity_count_mismatch')
      const ids = new Set<number>()
      for (const row of payload.rows as ReplayRow[]) {
        if (!Number.isSafeInteger(row.id) || ids.has(row.id)
          || Object.values(row).some(v => v != null && !['string','number'].includes(typeof v))
          || typeof row.symbol !== 'string' || !row.symbol || typeof row.trade_date !== 'string'
          || !/^\d{4}-\d{2}-\d{2}$/.test(row.trade_date))
          throw new Error('retention_replay_identity_invalid')
        if (identities) {
          const identity = identities.get(row.id)
          if (!identity || !['symbol','signal_date','trade_date','setup_id','row_checksum'].every(k => row[k] === identity[k]))
            throw new Error('retention_replay_compact_identity_mismatch')
        } else if (row.id !== row.__cursor_key || row.trade_date !== row.__archive_date
          || typeof payload.cutoff_date !== 'string' || row.trade_date >= payload.cutoff_date)
          throw new Error('retention_replay_identity_invalid')
        ids.add(row.id)
      }
      const rows = (payload.rows as ReplayRow[]).filter(r => r.trade_date >= startDate && r.trade_date <= endDate)
      if (!rows.length) continue
      const hot = new Set<number>()
      for (let offset = 0; offset < rows.length; offset += 128) {
        const keys = rows.slice(offset, offset + 128).map(r => ({id:r.id,symbol:r.symbol,trade_date:r.trade_date,signal_date:r.signal_date,setup_id:r.setup_id}))
        const present = (await learning.prepare(`SELECT json_extract(j.value,'$.id') archived_id FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM s12_replay_trade_outcomes t WHERE t.id=json_extract(j.value,'$.id') OR (
            t.symbol=json_extract(j.value,'$.symbol') AND t.setup_id=json_extract(j.value,'$.setup_id')
            AND (t.trade_date=json_extract(j.value,'$.trade_date') OR t.signal_date=json_extract(j.value,'$.signal_date'))))`)
          .bind(JSON.stringify(keys)).all<{archived_id:number}>()).results ?? []
        for (const row of present) hot.add(row.archived_id)
      }
      if (expectedRelease && hot.size) throw new Error('retention_replay_snapshot_hot_conflict')
      const missing = rows.filter(r => !hot.has(r.id))
      if (!missing.length) continue
      if (!compact) {
        const proof = await learning.prepare(`SELECT checksum,dataset_id,row_count FROM learning_retention_releases_v1
          WHERE artifact_id=?`).bind(manifest.artifact_id).first<ReplayRow>()
        if (!proof || proof.checksum !== manifest.checksum || proof.dataset_id !== TABLE || proof.row_count !== manifest.row_count) {
          // Only legacy releases need the Ops JSON audit fallback. Do not rescan that growing table for every modern archive.
          const legacy = await ops.prepare(`SELECT MAX(i.completed_at) release_verified_at FROM data_retention_run_items i
            WHERE i.status='success' AND i.deleted_rows=?
              AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=?
              AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=?`)
            .bind(manifest.row_count,manifest.artifact_id,manifest.checksum).first<ReplayRow>()
          if (!legacy?.release_verified_at) throw new Error('retention_replay_release_receipt_incomplete')
        }
      }
      const accepted: ReplayRow[] = []
      for (const row of missing) {
        const clean = Object.fromEntries(Object.entries(row).filter(([k]) => !['__cursor_key','__archive_date','row_checksum'].includes(k)))
        const fingerprint = compact ? row.row_checksum : await replayRowChecksum(clean)
        const keys = replayIdentityKeys(row)
        if (keys.some(k => seen.has(k) && seen.get(k) !== fingerprint)) throw new Error('retention_replay_conflicting_versions')
        if (keys.every(k => seen.has(k))) continue
        for (const key of keys) seen.set(key, fingerprint)
        accepted.push(clean)
      }
      if (accepted.length) yield accepted
    }
    if (manifests.length < 100) return
  }
}

const COLUMNS = REPLAY_PROJECTED_COLUMNS

/** Run the SAME trusted consumer SQL in D1, including lifecycle joins and SQLite date semantics.
 * Only required scalars cross the network; original JSON stays in immutable R2.
 */
export async function* projectS12ReplayChunk(db: D1Database, rows: ReplayRow[], sql: string, params: unknown[]) {
  if (!sql.includes('s12_replay_trade_outcomes')) throw new Error('retention_replay_projection_invalid')
  const cte = `WITH retained_replay AS (SELECT ${COLUMNS.map(c => `json_extract(j.value,'$.${c}') AS ${c}`).join(',')}
    FROM json_each(?) j) `
  const query = cte + sql.replaceAll('s12_replay_trade_outcomes', 'retained_replay')
  let batch: ReplayRow[] = [], size = 2
  async function execute() {
    return (await db.prepare(query).bind(JSON.stringify(batch), ...params).all<ReplayRow>()).results ?? []
  }
  for (const row of rows) {
    const projected = projectReplayRow(row)
    const bytes = encoder.encode(JSON.stringify(projected)).length + 1
    if (bytes > 48 * 1024) throw new Error('retention_replay_projection_row_too_large')
    if (batch.length && (batch.length >= 128 || size + bytes > 48 * 1024)) {
      yield await execute(); batch = []; size = 2
    }
    batch.push(projected); size += bytes
  }
  if (batch.length) yield await execute()
}
