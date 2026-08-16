import {
  DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION,
  strictDataDomainControlRevision,
} from './dataDomainControlRevision'

export type DataDomainShadowRow = Record<string, unknown>

export const DATA_DOMAIN_FULL_CHECKSUM_LIMIT = 1000
export const DATA_DOMAIN_DIRECT_MANIFEST_SCHEMA_VERSION = 'canonical-json-array-sha256-v1'
export const DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION = 'rolling-page-sha256-v1'
export const DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION = 'data-domain-shadow-full-table-v3'
export const DATA_DOMAIN_CONTROL_PROGRESS_SCHEMA_VERSION = 'data-domain-shadow-manifest-progress-v3'
export const DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION =
  'expected-return-control-semantic-v2'
export const DATA_DOMAIN_CONTROL_TABLES = [
  'model_artifact_registry',
  'expected_return_artifact_payloads',
  'model_champion_history',
  'model_champion_pointers',
] as const
export type DataDomainControlTable = typeof DATA_DOMAIN_CONTROL_TABLES[number]

const TABLE_PAGE_LIMITS: Readonly<Record<string, number>> = {
  model_artifact_registry: 25,
  expected_return_artifact_payloads: 25,
  model_champion_history: 25,
  model_champion_pointers: 25,
  screener_funnel_runs: 1,
}

export function isDataDomainControlTable(table: string): table is DataDomainControlTable {
  return (DATA_DOMAIN_CONTROL_TABLES as readonly string[]).includes(table)
}

export function isExpectedReturnSemanticControlTable(table: string): boolean {
  return table === 'expected_return_artifact_payloads'
    || table === 'model_champion_history'
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid_sql_identifier:${value}`)
  return `"${value}"`
}

export function dataDomainManifestPageLimit(table: string, requested: number): number {
  const finiteRequested = Number.isFinite(requested) ? Math.floor(requested) : 1
  const normalized = Math.max(1, Math.min(finiteRequested, 4000))
  return Math.min(normalized, TABLE_PAGE_LIMITS[table] ?? normalized)
}

export type DataDomainFullTableParityReceipt = {
  status?: string | null
  source_count?: number | string | null
  target_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  evidence_json?: string | null
  checked_at?: string | null
}

function strictNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function receiptTimestampMs(value: unknown): number {
  const raw = String(value ?? '').trim()
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(raw)) {
    return Date.parse(`${raw.replace(' ', 'T')}Z`)
  }
  return Date.parse(raw)
}

export function isAuthoritativeDataDomainFullTableParity(
  table: string,
  receipt: DataDomainFullTableParityReceipt | null | undefined,
): boolean {
  if (!receipt || receipt.status !== 'pass') return false
  const sourceCount = strictNonNegativeInteger(receipt.source_count)
  const targetCount = strictNonNegativeInteger(receipt.target_count)
  const sourceChecksum = String(receipt.source_checksum ?? '')
  const targetChecksum = String(receipt.target_checksum ?? '')
  if (sourceCount == null || targetCount == null || sourceCount !== targetCount) return false
  if (!sourceChecksum || sourceChecksum !== targetChecksum) return false
  if (!isDataDomainControlTable(table)) return true
  if (!/^[a-f0-9]{64}$/.test(sourceChecksum)) return false
  let evidence: Record<string, unknown>
  try {
    const parsed = JSON.parse(String(receipt.evidence_json ?? ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    evidence = parsed as Record<string, unknown>
  } catch {
    return false
  }
  const semanticRowsScanned = strictNonNegativeInteger(evidence.semantic_rows_scanned)
  const semanticRowsApplicable = strictNonNegativeInteger(evidence.semantic_rows_applicable)
  const semanticRowsValidated = strictNonNegativeInteger(evidence.semantic_rows_validated)
  const sourceRevision = strictDataDomainControlRevision(evidence.source_revision)
  const targetRevision = strictDataDomainControlRevision(evidence.target_revision)
  const semanticValid = !isExpectedReturnSemanticControlTable(table) || (
    evidence.semantic_validation_schema_version
      === DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION
    && evidence.semantic_validation_status === 'pass'
    && semanticRowsScanned === sourceCount
    && semanticRowsApplicable !== null
    && semanticRowsValidated !== null
    && semanticRowsApplicable === semanticRowsValidated
    && semanticRowsApplicable <= sourceCount
  )
  return semanticValid
    && evidence.schema_version === DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION
    && evidence.revision_schema_version === DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION
    && sourceRevision !== null
    && targetRevision !== null
    && evidence.parity_scope === 'resumable_full_table_manifest'
    && evidence.manifest_schema_version === DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION
    && Number.isInteger(evidence.manifest_page_limit)
    && evidence.manifest_page_limit === dataDomainManifestPageLimit(table, 4000)
}

export function isDataDomainFullTableParityFresh(
  table: string,
  receipt: DataDomainFullTableParityReceipt | null | undefined,
  parityNotBefore: string | null | undefined,
): boolean {
  // Generic tables do not have mutation-revision triggers.  A session watermark
  // therefore forces a fresh, resumable manifest instead of trusting a receipt
  // indefinitely after a same-row-count UPDATE behind the old cursor.
  if (!parityNotBefore && !isDataDomainControlTable(table)) return true
  const checkedAtMs = receiptTimestampMs(receipt?.checked_at)
  const notBeforeMs = receiptTimestampMs(parityNotBefore)
  return Number.isFinite(checkedAtMs)
    && Number.isFinite(notBeforeMs)
    && checkedAtMs >= notBeforeMs
}

export function canonicalRows(
  rows: readonly DataDomainShadowRow[],
  columns: readonly string[],
): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
    ),
  )
}

export async function checksumText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function checksumRows(
  rows: readonly DataDomainShadowRow[],
  columns: readonly string[],
): Promise<string> {
  return checksumText(canonicalRows(rows, columns))
}

export async function checksumRollingManifest(
  previousManifest: string | null,
  batchChecksum: string,
  batchRows: number,
): Promise<string> {
  return checksumText(JSON.stringify({
    previous_manifest: previousManifest,
    batch_checksum: batchChecksum,
    batch_rows: batchRows,
  }))
}

export async function boundedDataDomainTableManifest(input: {
  db: D1Database
  table: string
  columns: readonly string[]
  primaryKeys: readonly string[]
  pageLimit: number
  mode: 'canonical' | 'rolling'
}): Promise<{ rowCount: number; checksum: string | null; pageLimit: number }> {
  if (!input.primaryKeys.length) throw new Error(`bounded_manifest_primary_key_missing:${input.table}`)
  const pageLimit = dataDomainManifestPageLimit(input.table, input.pageLimit)
  const columnSql = input.columns.map(identifier).join(', ')
  const keySql = input.primaryKeys.map(identifier).join(', ')
  const directBodies: string[] = []
  let rollingManifest: string | null = null
  let cursor: unknown[] | null = null
  let rowCount = 0
  while (true) {
    const where = cursor
      ? `WHERE (${keySql}) > (${input.primaryKeys.map(() => '?').join(', ')})`
      : ''
    const page = await input.db.prepare(`
      SELECT ${columnSql}
        FROM ${identifier(input.table)}
        ${where}
       ORDER BY ${keySql}
       LIMIT ?
    `).bind(...(cursor ?? []), pageLimit).all<DataDomainShadowRow>()
    const rows = page.results ?? []
    if (!rows.length) break
    const canonical = canonicalRows(rows, input.columns)
    if (input.mode === 'rolling') {
      rollingManifest = await checksumRollingManifest(
        rollingManifest,
        await checksumText(canonical),
        rows.length,
      )
    } else {
      const body = canonical.slice(1, -1)
      if (body) directBodies.push(body)
    }
    rowCount += rows.length
    const last = rows.at(-1)!
    cursor = input.primaryKeys.map((column) => last[column] ?? null)
  }
  if (input.mode === 'rolling' && rollingManifest == null) {
    rollingManifest = await checksumRollingManifest(
      null,
      await checksumText(canonicalRows([], input.columns)),
      0,
    )
  }
  return {
    rowCount,
    checksum: input.mode === 'rolling'
      ? rollingManifest
      : await checksumText(`[${directBodies.join(',')}]`),
    pageLimit,
  }
}
