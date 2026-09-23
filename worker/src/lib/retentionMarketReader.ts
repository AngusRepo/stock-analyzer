import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'

const KEYS = { stock_prices: 'stock_id', technical_indicators: 'stock_id', chip_data: 'symbol', margin_data: 'stock_id', canonical_fundamental_features: 'stock_id' } as const
export type MarketHistoryTable = keyof typeof KEYS
type Row = Record<string, unknown>
const SCHEMA = 'd1-retention-hot-window-drain-v1'

/** Preserve complete single-stock history; only one archive chunk is resident. */
export async function mergeArchivedMarketHistory(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>, table: MarketHistoryTable, stockKey: number | string,
  since: string, hotRows: Row[], until = '9999-12-31', rowFilter: (row: Row) => boolean = () => true,
): Promise<Row[]> {
  const key = KEYS[table]
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until))
    throw new Error('retention_market_request_invalid')
  const ops = databaseForDataDomain(env, 'ops'), market = databaseForDataDomain(env, 'market')
  const fundamental = table === 'canonical_fundamental_features'
  const dateColumn = fundamental ? 'available_date' : 'date'
  const rowKey = (row: Row) => fundamental ? JSON.stringify([row.period, row.source]) : String(row.date)
  const hot = new Set(hotRows.map(rowKey))
  const merged = new Map(hotRows.map(row => [rowKey(row), row]))
  const fingerprints = new Map<string, string>()
  const domain = 'retention_canonical_market_hot_v1_' + table
  let cursor = ''
  while (true) {
    const manifests = (await ops.prepare(`SELECT a.artifact_id,a.domain,a.r2_key,a.checksum,a.row_count,a.byte_size,
      a.schema_version,a.metadata_json,
      (SELECT MAX(i.completed_at) FROM data_retention_run_items i WHERE i.status='success'
        AND i.deleted_rows=a.row_count
        AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id
        AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=a.checksum) release_verified_at
      FROM run_artifacts a
      WHERE domain=? AND schema_version=? AND retention_class='ten_year_cold_archive'
        AND status='ready' AND payload_deleted_at IS NULL AND artifact_id>?
        AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.coverage_end') END,'9999-12-31')>=?
        AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.coverage_start') END,'0000-01-01')<=?
      ORDER BY artifact_id LIMIT 100`).bind(domain, SCHEMA, cursor, since, until).all<Record<string, any>>()).results ?? []
    if (!manifests.length) break
    for (const manifest of manifests) {
      cursor = manifest.artifact_id
      const metadata = JSON.parse(manifest.metadata_json || '{}')
      // New archives identify their stock keys. Legacy unknown metadata is read,
      // never treated as proof that a stock is absent.
      if (Array.isArray(metadata.stock_keys) && metadata.stock_keys.length && !metadata.stock_keys.includes(stockKey)) continue
      if (!(manifest.byte_size > 0 && manifest.byte_size <= 7 * 1024 * 1024))
        throw new Error('retention_market_archive_size_invalid')
      const object = await env.ARTIFACTS?.get(manifest.r2_key)
      if (!object) throw new Error('retention_market_archive_missing')
      if (object.size > 7 * 1024 * 1024) throw new Error('retention_market_archive_size_invalid')
      const raw = await object.text()
      if (await sha256Text(raw) !== manifest.checksum) throw new Error('retention_market_checksum_mismatch')
      const body = JSON.parse(raw), payload = body.payload
      if (body.domain !== domain || body.schema_version !== SCHEMA || payload?.schema_version !== SCHEMA
          || payload.dataset_id !== table || payload.source_domain !== 'market' || payload.policy_id !== 'canonical_market_hot_v1'
          || !Array.isArray(payload.rows) || payload.rows.length !== manifest.row_count)
        throw new Error('retention_market_payload_mismatch')
      let missing = payload.rows.filter((row: Row) => row[key] === stockKey && typeof row[dateColumn] === 'string'
        && String(row[dateColumn]) >= since && String(row[dateColumn]) <= until && rowFilter(row) && !hot.has(rowKey(row))) as Row[]
      if (!missing.length) continue
      if (fundamental) {
        // A current value outside the caller's as-of filter still supersedes the
        // same natural key. An old backup must not resurrect a revised record.
        const present = (await market.prepare(`SELECT f.period,f.source FROM canonical_fundamental_features f
          JOIN json_each(?) j ON f.period IS json_extract(j.value,'$.period') AND f.source IS json_extract(j.value,'$.source')
          WHERE f.stock_id=?`).bind(JSON.stringify(missing.map(row => ({period:row.period,source:row.source}))),stockKey).all<Row>()).results ?? []
        const known = new Set(present.map(rowKey))
        missing = missing.filter(row => !known.has(rowKey(row)))
        if (!missing.length) continue
      }
      // New proof is atomic with source deletion. Legacy completed OPS receipts
      // must bind the same artifact, checksum and exact deleted-row count.
      const proof = manifest.release_verified_at ? null : await market.prepare(`SELECT checksum,dataset_id,row_count FROM market_retention_releases_v1 WHERE artifact_id=?`)
        .bind(manifest.artifact_id).first<Record<string, any>>()
      if (!manifest.release_verified_at && (!proof || proof.checksum !== manifest.checksum || proof.dataset_id !== table || proof.row_count !== manifest.row_count))
        throw new Error('retention_market_release_receipt_incomplete')
      for (const row of missing) {
        if (!Number.isSafeInteger(row.__cursor_key) || row.__archive_date !== row[dateColumn]
            || typeof payload.cutoff_date !== 'string' || String(row[dateColumn]) >= payload.cutoff_date)
          throw new Error('retention_market_row_identity_invalid')
        const clean = Object.fromEntries(Object.entries(row).filter(([name]) => !['__cursor_key', '__archive_date'].includes(name)))
        const date = rowKey(clean)
        const fingerprint = await sha256Text(JSON.stringify(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b))))
        if (fingerprints.has(date) && fingerprints.get(date) !== fingerprint)
          throw new Error('retention_market_conflicting_versions')
        fingerprints.set(date, fingerprint)
        merged.set(date, clean)
      }
    }
    if (manifests.length < 100) break
  }
  return [...merged.values()].sort((a, b) => String(a[dateColumn]).localeCompare(String(b[dateColumn])))
}
