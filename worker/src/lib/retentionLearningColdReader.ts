import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'
import { LEARNING_COLD_IDENTITY, LEARNING_DRAIN_POLICY_ID } from './retentionLearningDrainGates'

// D1-M3 generic Learning cold reader: exact rows released by the hot-window drain
// (schema d1-retention-hot-window-drain-v1). Archive-only exports have no release proof and are
// never read. A hot row with the same natural identity always wins (recovered / rewritten data).
// Reads are bounded: one verified archive chunk resident at a time, and a total budget that
// fails closed instead of truncating history.

export type LearningColdEnv = Pick<Bindings, 'DB'> & Partial<Bindings>
type Row = Record<string, unknown>
export type LearningColdRow = { row: Row; rowid: number; artifactId: string }

const SCHEMA = 'd1-retention-hot-window-drain-v1'
const MAX_OBJECT_BYTES = 7 * 1024 * 1024
export const LEARNING_COLD_READ_BUDGET = { bytes: 64 * 1024 * 1024, manifests: 512, rows: 200_000 } as const

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('retention_learning_identifier_invalid')
  return `"${value}"`
}

function identityKey(columns: readonly string[], row: Row): string | null {
  const values = columns.map(column => row[column])
  return values.some(value => value === null || value === undefined) ? null : JSON.stringify([columns.join(','), ...values])
}

async function fingerprint(row: Row): Promise<string> {
  return sha256Text(JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
}

/** Hot natural identities among `rows`, for every identity column set of the dataset. */
async function hotIdentities(learning: D1Database, dataset: string, rows: Row[]): Promise<Set<string>> {
  const spec = LEARNING_COLD_IDENTITY[dataset]
  const present = new Set<string>()
  for (const columns of spec.identityKeys) {
    const wanted = rows.filter(row => identityKey(columns, row) !== null)
      .map(row => Object.fromEntries(columns.map(column => [column, row[column]])))
    for (let offset = 0; offset < wanted.length; offset += 200) {
      const chunk = wanted.slice(offset, offset + 200)
      const join = columns.map(column => `t.${identifier(column)} IS json_extract(j.value,'$.${column}')`).join(' AND ')
      const found = (await learning.prepare(`SELECT ${columns.map(column => `t.${identifier(column)}`).join(',')}
          FROM ${identifier(dataset)} t JOIN json_each(?) j ON ${join}`)
        .bind(JSON.stringify(chunk)).all<Row>()).results ?? []
      for (const row of found) present.add(identityKey(columns, row)!)
    }
  }
  return present
}

export async function* archivedLearningRows(env: LearningColdEnv, learning: D1Database, dataset: string,
  options: { startDate: string; endDate: string; rowFilter?: (row: Row) => boolean;
    budget?: { bytes: number; manifests: number; rows: number } }): AsyncGenerator<LearningColdRow[]> {
  const spec = LEARNING_COLD_IDENTITY[dataset]
  if (!spec) throw new Error(`retention_learning_dataset_unsupported:${dataset}`)
  const { startDate, endDate } = options
  if (![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date)) || startDate > endDate)
    throw new Error('retention_learning_request_invalid')
  const budget = options.budget ?? LEARNING_COLD_READ_BUDGET
  const domain = `retention_${LEARNING_DRAIN_POLICY_ID}_${dataset}`
  const ops = databaseForDataDomain(env, 'ops')
  const seen = new Map<string, string>()
  // Rows of exported-but-never-released chunks that are absent from hot; resolved after the scan.
  const unreleased: string[] = []
  let cursor = '', bytes = 0, manifestsRead = 0, rowsRead = 0
  while (true) {
    const manifests = (await ops.prepare(`SELECT a.artifact_id,a.domain,a.r2_key,a.checksum,a.row_count,a.byte_size,
      a.schema_version,a.metadata_json,
      (SELECT MAX(i.completed_at) FROM data_retention_run_items i WHERE i.status='success'
        AND i.deleted_rows=a.row_count
        AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id
        AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=a.checksum) release_verified_at
      FROM run_artifacts a WHERE a.domain=? AND a.schema_version=? AND a.retention_class='ten_year_cold_archive'
        AND a.status='ready' AND a.checksum_verified_at IS NOT NULL AND a.payload_deleted_at IS NULL AND a.artifact_id>?
        AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')>=?
        AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')<=?
      ORDER BY a.artifact_id LIMIT 100`).bind(domain, SCHEMA, cursor, startDate, endDate).all<Record<string, any>>()).results ?? []
    if (!manifests.length) break
    for (const manifest of manifests) {
      cursor = manifest.artifact_id
      if (!(Number.isSafeInteger(manifest.byte_size) && manifest.byte_size > 0 && manifest.byte_size <= MAX_OBJECT_BYTES))
        throw new Error('retention_learning_archive_size_invalid')
      manifestsRead += 1
      bytes += manifest.byte_size
      if (manifestsRead > budget.manifests || bytes > budget.bytes)
        throw new Error(`retention_learning_read_budget_exceeded:${dataset}`)
      const object = await env.ARTIFACTS?.get(manifest.r2_key)
      if (!object) throw new Error('retention_learning_archive_missing')
      if (object.size !== manifest.byte_size) throw new Error('retention_learning_archive_size_invalid')
      const raw = await object.text()
      if (await sha256Text(raw) !== manifest.checksum) throw new Error('retention_learning_checksum_mismatch')
      const body = JSON.parse(raw), payload = body.payload
      if (body.domain !== domain || body.schema_version !== SCHEMA || payload?.schema_version !== SCHEMA
        || payload.dataset_id !== dataset || payload.source_domain !== 'learning' || payload.policy_id !== LEARNING_DRAIN_POLICY_ID
        || typeof payload.cutoff_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.cutoff_date) || !Array.isArray(payload.rows) || !payload.rows.length
        || payload.rows.length !== manifest.row_count)
        throw new Error('retention_learning_payload_mismatch')
      const rowIds = new Set<number>()
      const relevant: { row: Row; rowid: number }[] = []
      for (const archived of payload.rows as Row[]) {
        const rowid = archived.__cursor_key as number
        const date = String(archived[spec.dateColumn] ?? '').slice(0, 10)
        if (!Number.isSafeInteger(rowid) || rowIds.has(rowid) || archived.__archive_date !== date
          || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= payload.cutoff_date)
          throw new Error('retention_learning_row_identity_invalid')
        rowIds.add(rowid)
        if (date < startDate || date > endDate) continue
        const row = Object.fromEntries(Object.entries(archived).filter(([key]) => key !== '__cursor_key' && key !== '__archive_date'))
        if (options.rowFilter && !options.rowFilter(row)) continue
        relevant.push({ row, rowid })
      }
      rowsRead += relevant.length
      if (rowsRead > budget.rows) throw new Error(`retention_learning_read_budget_exceeded:${dataset}`)
      if (!relevant.length) continue
      const hot = await hotIdentities(learning, dataset, relevant.map(item => item.row))
      const missing = relevant.filter(item => !spec.identityKeys.some(columns => {
        const key = identityKey(columns, item.row)
        return key !== null && hot.has(key)
      }))
      if (!missing.length) continue
      // A manifest alone proves an export, not a deletion: require the atomic source release
      // (or the completed OPS receipt) before treating a missing hot row as history.
      if (!manifest.release_verified_at) {
        const proof = await learning.prepare(`SELECT checksum,dataset_id,row_count FROM learning_retention_releases_v1
          WHERE artifact_id=?`).bind(manifest.artifact_id).first<Record<string, any>>()
        if (proof && (proof.checksum !== manifest.checksum || proof.dataset_id !== dataset || proof.row_count !== manifest.row_count))
          throw new Error('retention_learning_release_receipt_incomplete')
        if (!proof) {
          // The DELETE and its receipt commit in one batch, so this chunk never deleted anything (e.g. a
          // drain that stopped after the export). Its rows are history only if a released chunk serves
          // the same identity; that is checked once every manifest has been read.
          for (const item of missing) unreleased.push(rowIdentity(spec.identityKeys[0], item))
          continue
        }
      }
      const out: LearningColdRow[] = []
      for (const item of missing) {
        const identity = rowIdentity(spec.identityKeys[0], item)
        const print = await fingerprint(item.row)
        const previous = seen.get(identity)
        if (previous !== undefined) {
          if (previous !== print) throw new Error('retention_learning_conflicting_versions')
          continue
        }
        seen.set(identity, print)
        out.push({ row: item.row, rowid: item.rowid, artifactId: manifest.artifact_id })
      }
      if (out.length) yield out
    }
    if (manifests.length < 100) break
  }
  // A hot-missing row that only an unreleased export holds is lost history, never a shorter answer.
  if (unreleased.some(identity => !seen.has(identity))) throw new Error('retention_learning_release_receipt_incomplete')
}

function rowIdentity(columns: readonly string[], item: { row: Row; rowid: number }): string {
  return identityKey(columns, item.row) ?? JSON.stringify(['rowid', item.rowid])
}

/** Hot rows plus released cold rows of the same range, ordered by business date. */
export async function mergeArchivedLearningRows(env: LearningColdEnv, learning: D1Database, dataset: string,
  range: { startDate: string; endDate: string; rowFilter?: (row: Row) => boolean }, hotRows: Row[]): Promise<Row[]> {
  const merged = [...hotRows]
  for await (const chunk of archivedLearningRows(env, learning, dataset, range)) merged.push(...chunk.map(item => item.row))
  const dateColumn = LEARNING_COLD_IDENTITY[dataset].dateColumn
  return merged.sort((a, b) => String(a[dateColumn]).localeCompare(String(b[dateColumn])))
}

/** Exact-key lookup for an id-addressed dataset (dataset_snapshots by snapshot_id). */
export async function findArchivedLearningRow(env: LearningColdEnv, learning: D1Database, dataset: string,
  column: string, value: string, range: { startDate: string; endDate: string }): Promise<Row | null> {
  for await (const chunk of archivedLearningRows(env, learning, dataset, { ...range, rowFilter: row => row[column] === value })) {
    if (chunk.length) return chunk[0].row
  }
  return null
}
