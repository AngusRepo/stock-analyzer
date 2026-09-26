import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'

type Row = Record<string, any>
export type S12ArchiveEnv = Pick<Bindings, 'DB'> & Partial<Bindings>
const TABLE = 's12_structure_snapshots'
const DOMAIN = 'retention_learning_lineage_v1_' + TABLE
const SCHEMA = 'd1-retention-hot-window-drain-v1'
const SOURCES = new Set(['s12_candidate_snapshot', 's12_candidate_snapshot_reconstruction'])
const key = (r: Row) => JSON.stringify([r.trade_date, r.symbol, r.source])
const rank = (r: Row) => r.source === 's12_candidate_snapshot' ? 1 : 2
const better = (a: Row, b: Row) => rank(a) < rank(b) || (rank(a) === rank(b)
  && (String(a.updated_at ?? '') > String(b.updated_at ?? '')
    || (String(a.updated_at ?? '') === String(b.updated_at ?? '') && Number(a.id) > Number(b.id))))

/** Match the existing source priority / updated_at / id order, one winner per symbol. */
export async function mergeArchivedS12Evidence(env: S12ArchiveEnv, learning: D1Database,
  date: string, symbols: readonly string[], hotRows: Row[]): Promise<Row[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || symbols.length > 2000)
    throw new Error('retention_s12_request_invalid')
  const wanted = new Set(symbols), merged = new Map(hotRows.map(r => [String(r.symbol), r]))
  const seen = new Map<string, string>()
  const ops = databaseForDataDomain(env, 'ops')
  let cursor = ''
  while (true) {
    const manifests = (await ops.prepare(`SELECT a.artifact_id,a.domain,a.r2_key,a.checksum,a.row_count,a.byte_size,
      a.schema_version,a.metadata_json,
      (SELECT MAX(i.completed_at) FROM data_retention_run_items i WHERE i.status='success'
       AND i.deleted_rows=a.row_count
       AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id
       AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=a.checksum) release_verified_at
      FROM run_artifacts a WHERE a.domain=? AND a.schema_version=? AND a.retention_class='ten_year_cold_archive'
       AND a.status='ready' AND a.payload_deleted_at IS NULL AND a.artifact_id>?
       AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')>=?
       AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')<=?
      ORDER BY a.artifact_id LIMIT 100`).bind(DOMAIN, SCHEMA, cursor, date, date).all<Row>()).results ?? []
    if (!manifests.length) break
    for (const manifest of manifests) {
      cursor = manifest.artifact_id
      if (!(manifest.byte_size > 0 && manifest.byte_size <= 7 * 1024 * 1024))
        throw new Error('retention_s12_archive_size_invalid')
      const object = await env.ARTIFACTS?.get(manifest.r2_key)
      if (!object) throw new Error('retention_s12_archive_missing')
      if (object.size > 7 * 1024 * 1024) throw new Error('retention_s12_archive_size_invalid')
      const raw = await object.text()
      if (await sha256Text(raw) !== manifest.checksum) throw new Error('retention_s12_checksum_mismatch')
      const body = JSON.parse(raw), p = body.payload
      if (body.domain !== DOMAIN || body.schema_version !== SCHEMA || p?.schema_version !== SCHEMA
        || p.dataset_id !== TABLE || p.source_domain !== 'learning' || p.policy_id !== 'learning_lineage_v1'
        || !Array.isArray(p.rows) || !p.rows.length || p.rows.length !== manifest.row_count)
        throw new Error('retention_s12_payload_mismatch')
      const rowIds = new Set<number>()
      for (const r of p.rows as Row[]) {
        if (!Number.isSafeInteger(r.id) || r.id !== r.__cursor_key || rowIds.has(r.id)
          || typeof r.trade_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.trade_date)
          || r.trade_date !== r.__archive_date || typeof p.cutoff_date !== 'string' || r.trade_date >= p.cutoff_date
          || typeof r.symbol !== 'string' || !r.symbol || typeof r.source !== 'string' || !r.source)
          throw new Error('retention_s12_identity_invalid')
        rowIds.add(r.id)
      }
      const rows = (p.rows as Row[]).filter(r => r.trade_date === date && wanted.has(r.symbol) && SOURCES.has(r.source))
      if (!rows.length) continue
      // Check all current natural keys, including revisions excluded from the hot winner projection.
      const present = (await learning.prepare(`SELECT t.trade_date,t.symbol,t.source FROM s12_structure_snapshots t
        JOIN json_each(?) j ON t.trade_date=json_extract(j.value,'$.trade_date')
        AND t.symbol=json_extract(j.value,'$.symbol') AND t.source=json_extract(j.value,'$.source')`)
        .bind(JSON.stringify(rows.map(r => ({trade_date:r.trade_date,symbol:r.symbol,source:r.source}))))
        .all<Row>()).results ?? []
      const hot = new Set(present.map(key)), missing = rows.filter(r => !hot.has(key(r)))
      if (!missing.length) continue
      const proof = manifest.release_verified_at ? null : await learning.prepare(`SELECT checksum,dataset_id,row_count
        FROM learning_retention_releases_v1 WHERE artifact_id=?`).bind(manifest.artifact_id).first<Row>()
      if (!manifest.release_verified_at && (!proof || proof.checksum !== manifest.checksum
        || proof.dataset_id !== TABLE || proof.row_count !== manifest.row_count))
        throw new Error('retention_s12_release_receipt_incomplete')
      for (const row of missing) {
        const clean = Object.fromEntries(Object.entries(row).filter(([k]) => !['__cursor_key','__archive_date'].includes(k)))
        const fingerprint = await sha256Text(JSON.stringify(Object.entries(clean).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
        const identity = key(row)
        if (seen.has(identity) && seen.get(identity) !== fingerprint) throw new Error('retention_s12_conflicting_versions')
        seen.set(identity, fingerprint)
        const current = merged.get(row.symbol)
        if (!current || better(row, current)) merged.set(row.symbol, {
          symbol:row.symbol,source:row.source,state:row.state,ready:row.ready,invalidated:row.invalidated,
          updated_at:row.updated_at,id:row.id,
        })
      }
    }
    if (manifests.length < 100) break
  }
  return [...merged.values()]
}
