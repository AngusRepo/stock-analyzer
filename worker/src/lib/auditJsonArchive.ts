import type { Bindings } from '../types'
import {
  sha256Text,
  upsertDatasetSnapshotManifest,
  type DatasetSnapshotManifest,
} from './datasetSnapshots'
import {
  beginRetentionRun,
  checkpointRetentionItem,
  finishRetentionRun,
  loadRetentionCursor,
  type RetentionCursor,
} from './retentionRunLedger'
import { databaseForDataDomain, databaseForTable } from './dataDomainRegistry'

export const AUDIT_JSON_ARCHIVE_KIND = 'd1_audit_json_archive'
const AUDIT_JSON_RETENTION_POLICY_ID = 'audit_json_r2_v1'
export const AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE = 'ARCHIVE_D1_AUDIT_JSON_TO_R2'
export const AUDIT_JSON_RETENTION_DEFAULT_DAYS = 90
export const AUDIT_JSON_RETENTION_MIN_DAYS = 30
export const AUDIT_JSON_RETENTION_MAX_DAYS = 3650
export const AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE = 250
export const AUDIT_JSON_ARCHIVE_MAX_LIMIT_PER_TABLE = 1000
export const AUDIT_JSON_ARCHIVE_MIN_BLOB_BYTES = 1024
export const AUDIT_JSON_REF_V2_TARGET_ID = 'strategy_decision_log_ref_v2'
export const AUDIT_JSON_REF_V2_SCHEMA = 'strategy-decision-json-ref-v2'
export const AUDIT_JSON_REF_V2_GATE_KEY = 'retention:audit-json:strategy-decision-ref-v2:v1'
// V5 rebuild/repair rewrites most decision rows within 4 days; older rewrites
// only undo the compaction and are compacted again on a later night.
export const STRATEGY_DECISION_REF_V2_HOT_DAYS = 7
// 1000 rows / 20 rows per CAS statement. Statement-local MAX(rowid) numbering
// is collision-free only while one atomic D1 batch carries the whole attempt.
const REF_V2_MAX_STATEMENTS_PER_ATTEMPT = 50

export type AuditJsonArchiveTargetId =
  | 'paper_execution_events'
  | 'strategy_decision_log'
  | 'screener_funnel_items'
  | 'canonical_screener_funnel_items'
  | typeof AUDIT_JSON_REF_V2_TARGET_ID

type AuditJsonArchiveTable =
  | 'paper_execution_events'
  | 'strategy_decision_log'
  | 'screener_funnel_items'

type AuditJsonTargetConfig = {
  id: AuditJsonArchiveTargetId
  table: AuditJsonArchiveTable
  dateColumn: string
  keyColumn: string
  selectedColumns: string[]
  blobColumns: string[]
  /** Compact in place to ref-v2 and move the row to the table tail so SQLite frees pages. */
  mode?: 'ref_v2_move'
  hotDays?: number
  /** Excluded from default target lists; runs only when named and the KV gate is open. */
  optIn?: boolean
}

export type AuditJsonRefV2GateMode = 'manual' | 'scheduled'

export type AuditJsonRetentionPlanTable = {
  target: AuditJsonArchiveTargetId
  table: AuditJsonArchiveTable
  date_column: string
  cutoff_date: string
  retention_days: number
  cold_rows: number
  archiveable_rows: number
  min_date: string | null
  max_date: string | null
  archiveable_blob_bytes: number
  action: 'archive_to_r2_then_scrub_json_columns'
  dry_run: true
}

export type AuditJsonRetentionPlan = {
  dry_run: true
  archive_kind: typeof AUDIT_JSON_ARCHIVE_KIND
  business_date: string
  retention_days: number
  cutoff_date: string
  min_blob_bytes: number
  tables: AuditJsonRetentionPlanTable[]
  total_archiveable_rows: number
  total_archiveable_blob_bytes: number
  note: string
}

export type AuditJsonArchiveRunResult = {
  dry_run: boolean
  archive_kind: typeof AUDIT_JSON_ARCHIVE_KIND
  business_date: string
  run_id: string
  retention_days: number
  cutoff_date: string
  limit_per_table: number
  tables: Array<{
    target: AuditJsonArchiveTargetId
    table: AuditJsonArchiveTable
    candidate_rows: number
    archived_rows: number
    scrubbed_rows: number
    archived_blob_bytes: number
    /** UTF-8 payload bytes removed after successful CAS, not D1 physical size. */
    reclaimed_blob_bytes?: number
    skipped_no_savings_rows?: number
    r2_key: string | null
    snapshot_id: string | null
    checksum: string | null
    status: 'dry_run' | 'archived' | 'skipped' | 'failed'
    cursor_date: string | null
    cursor_key: string | null
    backlog_remaining: boolean
    error?: string
    cutoff_date?: string
    skipped_reason?: string
    planned_reclaimed_blob_bytes?: number
    schema_histogram?: Record<string, number>
    d1_size_before?: number | null
    d1_size_after?: number | null
  }>
  total_archived_rows: number
  total_scrubbed_rows: number
  total_archived_blob_bytes: number
}

const AUDIT_JSON_TARGETS: AuditJsonTargetConfig[] = [
  {
    id: 'strategy_decision_log',
    table: 'strategy_decision_log',
    dateColumn: 'date',
    keyColumn: 'decision_id',
    selectedColumns: [
      'decision_id',
      'date',
      'symbol',
      'name',
      'strategy_id',
      'strategy_version',
      'strategy_status',
      'alpha_bucket',
      'matched',
      'match_score',
      'reason_code',
      'context_json',
      'evidence_json',
      'created_at',
    ],
    blobColumns: ['context_json', 'evidence_json'],
  },
  {
    id: 'screener_funnel_items',
    table: 'screener_funnel_items',
    dateColumn: 'date',
    keyColumn: 'id',
    selectedColumns: [
      'id',
      'run_id',
      'date',
      'symbol',
      'name',
      'stage',
      'decision',
      'reason_code',
      'score_before',
      'score_after',
      'rank',
      'evidence',
      'created_at',
    ],
    blobColumns: ['evidence'],
  },
  {
    id: 'canonical_screener_funnel_items',
    table: 'screener_funnel_items',
    dateColumn: 'date',
    keyColumn: 'id',
    selectedColumns: [
      'id',
      'run_id',
      'date',
      'symbol',
      'name',
      'stage',
      'decision',
      'reason_code',
      'score_before',
      'score_after',
      'rank',
      'evidence',
      'created_at',
    ],
    blobColumns: ['evidence'],
  },
  {
    id: 'paper_execution_events',
    table: 'paper_execution_events',
    dateColumn: 'trade_date',
    keyColumn: 'id',
    selectedColumns: [
      'id',
      'account_id',
      'trade_date',
      'symbol',
      'side',
      'event_type',
      'status',
      'reason',
      'detail_json',
      'order_id',
      'pending_run_id',
      'source',
      'created_at',
    ],
    blobColumns: ['detail_json'],
  },
  {
    id: AUDIT_JSON_REF_V2_TARGET_ID,
    table: 'strategy_decision_log',
    dateColumn: 'date',
    keyColumn: 'decision_id',
    // Full row: the R2 pre-image is restorable and the CAS rejects any
    // concurrent V5/repair write, including the evaluability columns.
    selectedColumns: [
      'decision_id',
      'date',
      'symbol',
      'name',
      'strategy_id',
      'strategy_version',
      'strategy_status',
      'alpha_bucket',
      'matched',
      'match_score',
      'reason_code',
      'context_json',
      'evidence_json',
      'created_at',
      'context_id',
      'evidence_artifact_id',
      'evaluable',
      'evaluability_status',
      'unavailable_reason',
      'evaluation_contract_version',
    ],
    blobColumns: ['context_json', 'evidence_json'],
    mode: 'ref_v2_move',
    hotDays: STRATEGY_DECISION_REF_V2_HOT_DAYS,
    optIn: true,
  },
]

/** Allowlist of every target id a caller may name explicitly. */
export const AUDIT_JSON_ARCHIVE_TARGET_IDS: readonly AuditJsonArchiveTargetId[] =
  AUDIT_JSON_TARGETS.map((target) => target.id)

/** Targets used when a caller names none; opt-in targets are never implied. */
export const AUDIT_JSON_DEFAULT_TARGET_IDS: readonly AuditJsonArchiveTargetId[] =
  AUDIT_JSON_TARGETS.filter((target) => !target.optIn).map((target) => target.id)

const TARGET_BY_ID = new Map(AUDIT_JSON_TARGETS.map((target) => [target.id, target]))

export function isOptInAuditJsonTarget(value: string): boolean {
  return TARGET_BY_ID.get(value as AuditJsonArchiveTargetId)?.optIn === true
}

export async function readAuditJsonRefV2Gate(kv?: Pick<KVNamespace, 'get'> | null): Promise<AuditJsonRefV2GateMode | null> {
  if (!kv) return null
  try {
    const gate = await kv.get(AUDIT_JSON_REF_V2_GATE_KEY, 'json') as { mode?: unknown } | null
    return gate?.mode === 'manual' || gate?.mode === 'scheduled' ? gate.mode : null
  } catch {
    return null
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(Math.trunc(n), max))
}

function normalizeBusinessDate(value?: string | null): string {
  const trimmed = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function isoDateOffset(date: string, days: number): string {
  const base = new Date(`${date.slice(0, 10)}T00:00:00.000Z`)
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function selectedTargets(targets?: Array<string | null | undefined> | null): AuditJsonTargetConfig[] {
  const defaults = AUDIT_JSON_TARGETS.filter((target) => !target.optIn)
  if (!targets?.length) return defaults
  const selected = new Set(
    targets
      .flatMap((raw) => String(raw ?? '').split(','))
      .map((raw) => raw.trim())
      .filter(Boolean),
  )
  if (!selected.size) return defaults
  return AUDIT_JSON_TARGETS.filter((target) => selected.has(target.id))
}

function blobLengthExpr(target: AuditJsonTargetConfig): string {
  return target.blobColumns.map((column) => `LENGTH(COALESCE(${column}, ''))`).join(' + ')
}

function archiveableWhere(target: AuditJsonTargetConfig): string {
  if (target.mode === 'ref_v2_move') {
    // A row is done once any column carries the ref-v2 marker: the other column
    // was left verbatim because compaction could not make it smaller. Rows with
    // no JSON object hold nothing to compact and could never be marked.
    const unmarked = target.blobColumns
      .map((column) => `COALESCE(${column}, '') NOT LIKE '%"schema_version":"${AUDIT_JSON_REF_V2_SCHEMA}"%'`)
      .join(' AND ')
    const hasObject = target.blobColumns
      .map((column) => `(CASE WHEN json_valid(${column}) THEN json_type(${column}) END)='object'`)
      .join(' OR ')
    return `${unmarked} AND (${hasObject})`
  }
  return target.blobColumns
    .map((column) => `(
      LENGTH(COALESCE(${column}, '')) > ?
      AND COALESCE(${column}, '') NOT LIKE '%"archived_to_r2":true%'
    )`)
    .join(' OR ')
}

function archiveableBinds(target: AuditJsonTargetConfig, minBlobBytes: number): unknown[] {
  if (target.mode === 'ref_v2_move') return []
  return target.blobColumns.map(() => minBlobBytes)
}

function retentionEligibilityWhere(target: AuditJsonTargetConfig): string {
  if (target.id === 'strategy_decision_log') {
    return `strategy_decision_log.context_id IS NOT NULL
         AND strategy_decision_log.evidence_artifact_id IS NOT NULL`
  }
  if (target.id === 'canonical_screener_funnel_items') {
    return `(EXISTS (
             SELECT 1
               FROM canonical_run_heads h
              WHERE h.run_id = screener_funnel_items.run_id
           ) OR screener_funnel_items.run_id = COALESCE((
             SELECT latest.run_id
               FROM screener_funnel_runs latest
              WHERE latest.date = screener_funnel_items.date
                AND latest.status = 'success'
              ORDER BY latest.created_at DESC
              LIMIT 1
           ), ''))`
  }
  if (target.id !== 'screener_funnel_items') return '1=1'
  return `NOT EXISTS (
           SELECT 1
             FROM canonical_run_heads h
            WHERE h.run_id = screener_funnel_items.run_id
         )
         AND screener_funnel_items.run_id <> COALESCE((
           SELECT latest.run_id
             FROM screener_funnel_runs latest
            WHERE latest.date = screener_funnel_items.date
              AND latest.status = 'success'
            ORDER BY latest.created_at DESC
            LIMIT 1
         ), '')`
}

function cleanRunPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.=-]+/g, '_').slice(0, 160)
}

function rowKey(row: Record<string, unknown>, target: AuditJsonTargetConfig): string | number {
  const value = row[target.keyColumn]
  return typeof value === 'number' ? value : String(value ?? '')
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(String(value ?? '')).length
}

function rowBlobBytes(row: Record<string, unknown>, target: AuditJsonTargetConfig): number {
  return target.blobColumns.reduce((sum, column) => sum + byteLength(row[column]), 0)
}

type AuditJsonPointerInput = {
  table: string
  keyColumn: string
  keyValue: string | number
  blobColumn: string
  snapshotId: string
  r2Key: string
  checksum: string
  archivedAt: string
  originalByteLength: number
}

function buildPointer(input: AuditJsonPointerInput, hotFields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...hotFields,
    schema_version: 'd1-audit-json-pointer-v1',
    archived_to_r2: true,
    archive_kind: AUDIT_JSON_ARCHIVE_KIND,
    table: input.table,
    key_column: input.keyColumn,
    key_value: input.keyValue,
    blob_column: input.blobColumn,
    snapshot_id: input.snapshotId,
    r2_key: input.r2Key,
    checksum: input.checksum,
    archived_at: input.archivedAt,
    original_byte_length: input.originalByteLength,
  })
}

const EXISTING_POINTER_SCHEMAS = new Set([
  'd1-audit-json-pointer-v1', 'strategy-context-pointer-v1',
  'strategy-evidence-pointer-v1', 'legacy-screener-evidence-pointer-v1',
  AUDIT_JSON_REF_V2_SCHEMA,
])

// Historical recovery reads these fields directly with SQL/JSON and uses
// candidate + score_v2 when the shared candidate context is unavailable.
const STRATEGY_DECISION_RETAINED_FIELDS: Record<string, string[]> = {
  context_json: ['candidate', 'score_v2'],
  evidence_json: ['pit_reconstruction', 'feature_ref_diagnostics', 'evaluability',
    'signal_dsl_diagnostics', 'base_gate_diagnostics', 'rejection_diagnostics'],
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Keeps only the exact retained fields. Identity and archive metadata are not
 * duplicated: ids live in their own columns, artifact keys in ops run_artifacts,
 * projection constants in strategy_label_matrix_runs_v4, and the full pre-image
 * in the R2 chunk named by `archive` (dataset_snapshots checksum prefix).
 */
export function compactRefV2(original: unknown, blobColumn: string, archiveDigest: string, force = false): unknown {
  const parsed = parseJsonObject(original)
  if (!parsed || parsed.schema_version === AUDIT_JSON_REF_V2_SCHEMA) return original
  const retained = STRATEGY_DECISION_RETAINED_FIELDS[blobColumn] ?? []
  const compact = JSON.stringify({
    ...Object.fromEntries(Object.entries(parsed).filter(([key]) => retained.includes(key))),
    schema_version: AUDIT_JSON_REF_V2_SCHEMA,
    ...(blobColumn === 'evidence_json' ? { archive: archiveDigest } : {}),
  })
  return force || byteLength(compact) < byteLength(original) ? compact : original
}

/**
 * Every processed row must carry the marker in some column, or the marker
 * predicate re-selects it every cycle. When neither column shrinks, the
 * evidence (else context) object is compacted anyway; the R2 pre-image keeps it.
 */
export function compactRefV2Row(
  row: Record<string, unknown>, blobColumns: string[], archiveDigest: string,
): Record<string, unknown> {
  const compact = Object.fromEntries(blobColumns.map(column => [column, compactRefV2(row[column], column, archiveDigest)]))
  if (blobColumns.some(column => compact[column] !== row[column])) return compact
  const carrier = [...blobColumns].reverse().find(column => parseJsonObject(row[column]))
  return carrier ? { ...compact, [carrier]: compactRefV2(row[carrier], carrier, archiveDigest, true) } : compact
}

function refV2ArchiveDigest(checksum: string): string {
  return checksum.replace(/^sha256:/, '').slice(0, 24)
}

function compactBlob(target: AuditJsonTargetConfig, original: unknown, input: AuditJsonPointerInput): unknown {
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(String(original))
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value
  } catch { /* Non-JSON audit payloads can still be archived verbatim. */ }
  // Do not wrap a pointer in another pointer: its resolver may require the
  // original identity, and this also enlarges already compact strategy rows.
  if (parsed && (parsed.archived_to_r2 === true || EXISTING_POINTER_SCHEMAS.has(String(parsed.schema_version)))) return original

  let hotFields: Record<string, unknown> = {}
  if (target.id === 'strategy_decision_log') {
    if (!parsed) return original
    // Keep the exact values; never manufacture PIT or evaluability proof.
    const retained = STRATEGY_DECISION_RETAINED_FIELDS[input.blobColumn] ?? []
    hotFields = Object.fromEntries(Object.entries(parsed).filter(([key]) => retained.includes(key)))
  }
  const pointer = buildPointer(input, hotFields)
  // Guard every column independently, including NULL/empty siblings of a large
  // blob. A qualifying row is not evidence that both columns can be compacted.
  return byteLength(pointer) < byteLength(original) ? pointer : original
}

function retentionCursorPredicate(
  target: AuditJsonTargetConfig,
  cursor: RetentionCursor | null,
): { sql: string; binds: unknown[] } {
  if (!cursor?.cursor_date || cursor.cursor_key == null) return { sql: '', binds: [] }
  return {
    sql: `AND (${target.dateColumn} > ? OR (${target.dateColumn} = ? AND ${target.keyColumn} > ?))`,
    binds: [cursor.cursor_date, cursor.cursor_date, cursor.cursor_key],
  }
}

export function buildAuditJsonCandidateQuery(
  targetId: AuditJsonArchiveTargetId, cutoffDate: string,
  limit: number, minBlobBytes: number, cursor: RetentionCursor | null,
): { sql: string; binds: unknown[] } {
  const target = TARGET_BY_ID.get(targetId)
  if (!target) throw new Error('audit_json_target_invalid')
  const keyset = retentionCursorPredicate(target, cursor)
  // Fix page membership before quoting payloads: LIMIT on the payload SELECT
  // still serializes every eligible row when SQLite sorts an unindexed suffix.
  // Both materialized steps share one SQLite statement/snapshot.
  const rowBytes = target.selectedColumns.map(column =>
    `(length(CAST(json_quote(${target.table}.${column}) AS BLOB))+${column.length + 4})`).join('+') + '+64'
  return { sql: `
    WITH key_page AS MATERIALIZED (
      SELECT ${target.keyColumn} row_key, ${target.dateColumn} row_date
        FROM ${target.table}
       WHERE ${target.dateColumn} IS NOT NULL AND ${target.dateColumn}<?
         AND (${retentionEligibilityWhere(target)}) AND (${archiveableWhere(target)}) ${keyset.sql}
       ORDER BY ${target.dateColumn},${target.keyColumn} LIMIT ?
    ), candidates AS MATERIALIZED (
      SELECT k.row_key, k.row_date, (${rowBytes}) row_bytes
        FROM key_page k JOIN ${target.table} ON ${target.table}.${target.keyColumn}=k.row_key
    ), budgeted AS MATERIALIZED (
      SELECT *,SUM(row_bytes) OVER (ORDER BY row_date,row_key) total_bytes FROM candidates
    ) SELECT ${target.selectedColumns.map(column => `${target.table}.${column}`).join(',')},${target.mode === 'ref_v2_move' ? `${target.table}.rowid __rowid,` : ''}
        (${blobLengthExpr(target)}) __blob_bytes
      FROM ${target.table} JOIN budgeted b ON b.row_key=${target.table}.${target.keyColumn}
      WHERE b.total_bytes<=1048576 ORDER BY ${target.table}.${target.dateColumn},${target.table}.${target.keyColumn}
  `, binds: [cutoffDate, ...archiveableBinds(target, minBlobBytes), ...keyset.binds, limit] }
}

async function loadCandidateRows(
  db: D1Database, target: AuditJsonTargetConfig, cutoffDate: string,
  limit: number, minBlobBytes: number, cursor: RetentionCursor | null,
): Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }> {
  const query = buildAuditJsonCandidateQuery(target.id, cutoffDate, limit, minBlobBytes, cursor)
  const { results } = await db.prepare(query.sql).bind(...query.binds).all<Record<string, unknown>>()
  const rows = results ?? []
  const last = rows.at(-1)
  const nextCursor = last ? { ...cursor, cursor_date: String(last[target.dateColumn]), cursor_key: String(last[target.keyColumn]) } as RetentionCursor : cursor
  const tail = retentionCursorPredicate(target, nextCursor)
  const more = await db.prepare(`SELECT 1 pending FROM ${target.table}
    WHERE ${target.dateColumn} IS NOT NULL AND ${target.dateColumn}<?
      AND (${retentionEligibilityWhere(target)}) AND (${archiveableWhere(target)}) ${tail.sql} LIMIT 1`)
    .bind(cutoffDate, ...archiveableBinds(target, minBlobBytes), ...tail.binds).first()
  if (!rows.length && more) throw new Error(`audit_json_row_requires_large_object_path:${target.id}`)
  return { rows, hasMore: more != null }
}

export function auditJsonRowsPerUpdateStatement(blobColumnCount: number): number {
  // Each row contributes one key and one pointer per blob column to every CASE,
  // plus one key in the WHERE IN clause. D1 allows at most 100 bound params.
  return Math.max(1, Math.floor(100 / ((2 * blobColumnCount) + 1)))
}

export function buildAuditJsonCompareAndSwap(
  target: AuditJsonTargetConfig, rows: Record<string, unknown>[],
  pointerFor: (row: Record<string, unknown>, blobColumn: string) => unknown,
  options: { moveRowid?: boolean } = {},
) {
  const keyMatch = `json_extract(b.value,'$.original.${target.keyColumn}') IS ${target.table}.${target.keyColumn}`
  const same = target.selectedColumns.map(column =>
    `json_extract(b.value,'$.original.${column}') IS ${target.table}.${column}`).join(' AND ')
  // Shrinking a row in place frees no SQLite page. A new rowid re-inserts the
  // row at the table tail so emptied leaf pages are released. The uncorrelated
  // MAX is evaluated once per statement, so ord 0..n-1 yields unique rowids
  // and a writer insert between statements is already counted in the next MAX.
  const moveRowid = options.moveRowid === true
  const rowidAssignment = moveRowid
    ? `rowid=(SELECT MAX(rowid) FROM ${target.table})+1+(SELECT json_extract(b.value,'$.ord') FROM backed_up b WHERE ${keyMatch}),`
    : ''
  const assignments = rowidAssignment + target.blobColumns.map(column =>
    `${column}=(SELECT json_extract(b.value,'$.pointers.${column}') FROM backed_up b WHERE ${keyMatch})`).join(',')
  // SQLite permits NULL in a non-integer PRIMARY KEY unless NOT NULL is explicit.
  const includeNullKey = rows.some(row => row[target.keyColumn] == null)
  // Probe only backed-up primary keys before the complete original-value CAS.
  // A correlated EXISTS alone scans every old row once per scrub statement.
  return {
    sql: `WITH backed_up AS MATERIALIZED (SELECT value FROM json_each(?))
      UPDATE ${target.table} SET ${assignments}
      WHERE (${target.keyColumn} IN (
          SELECT json_extract(value,'$.original.${target.keyColumn}') FROM backed_up
        )${includeNullKey ? ` OR ${target.keyColumn} IS NULL` : ''})
        AND ${target.dateColumn}<? AND (${retentionEligibilityWhere(target)})
        AND EXISTS (SELECT 1 FROM backed_up b WHERE ${keyMatch} AND ${same})`,
    rowsJson: JSON.stringify(rows.map((row, ord) => ({
      original: Object.fromEntries(target.selectedColumns.map(column => [column, row[column] ?? null])),
      pointers: Object.fromEntries(target.blobColumns.map(column => [column, pointerFor(row, column)])),
      ...(moveRowid ? { ord } : {}),
    }))),
  }
}

async function scrubArchivedRows(
  db: D1Database, target: AuditJsonTargetConfig, rows: Record<string, unknown>[],
  cutoffDate: string, pointerFor: (row: Record<string, unknown>, blobColumn: string) => unknown,
): Promise<number> {
  if (!rows.length) return 0
  const moveRowid = target.mode === 'ref_v2_move'
  const statements: D1PreparedStatement[] = []
  const perStatement = auditJsonRowsPerUpdateStatement(target.blobColumns.length)
  for (let i = 0; i < rows.length; i += perStatement) {
    const exact = buildAuditJsonCompareAndSwap(target, rows.slice(i, i + perStatement), pointerFor, { moveRowid })
    statements.push(db.prepare(exact.sql).bind(exact.rowsJson, cutoffDate))
  }
  let changed = 0
  for (let i = 0; i < statements.length; i += 50) {
    const results = await db.batch(statements.slice(i, i + 50))
    changed += results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0)
  }
  if (changed !== rows.length) throw new Error('audit_json_source_changed_before_scrub')
  return changed
}

async function d1SizeAfter(db: D1Database): Promise<number | null> {
  // Observational only: a probe failure must not fail an attempt whose CAS
  // already committed. D1 reports authoritative database bytes in result meta.
  try {
    const probe = await db.prepare('SELECT 1 AS audit_json_ref_v2_size_probe').all()
    const size = Number((probe as { meta?: { size_after?: unknown } }).meta?.size_after)
    return Number.isFinite(size) && size > 0 ? size : null
  } catch {
    return null
  }
}

async function refV2RowidMap(
  db: D1Database, target: AuditJsonTargetConfig, rows: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  try {
    const { results } = await db.prepare(`SELECT ${target.keyColumn} row_key, rowid new_rowid FROM ${target.table}
      WHERE ${target.keyColumn} IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(rows.map(row => row[target.keyColumn]))).all<{ row_key: unknown; new_rowid: number }>()
    const moved = new Map((results ?? []).map(row => [String(row.row_key), Number(row.new_rowid)]))
    // Old rowid -> new rowid per key; the old side is in the R2 pre-image (__rowid).
    const pairs = rows.map(row => [String(row[target.keyColumn]), Number(row.__rowid), moved.get(String(row[target.keyColumn])) ?? null])
    const newRowids = pairs.filter(pair => typeof pair[2] === 'number' && pair[2] !== pair[1]).map(pair => pair[2] as number)
    return {
      moved_rows: newRowids.length,
      rowid_map_digest: await sha256Text(JSON.stringify(pairs)),
      new_rowid_min: newRowids.length ? Math.min(...newRowids) : null,
      new_rowid_max: newRowids.length ? Math.max(...newRowids) : null,
    }
  } catch (error) {
    return { rowid_map_error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }
  }
}

function refV2PlanStats(
  target: AuditJsonTargetConfig, rows: Record<string, unknown>[],
): { planned_reclaimed_blob_bytes: number; schema_histogram: Record<string, number> } {
  const digest = '0'.repeat(24)
  let planned = 0
  const histogram: Record<string, number> = {}
  for (const row of rows) {
    const schema = String(parseJsonObject(row.context_json)?.schema_version ?? 'unparsed')
    histogram[schema] = (histogram[schema] ?? 0) + 1
    const compact = compactRefV2Row(row, target.blobColumns, digest)
    planned +=Math.max(0, rowBlobBytes(row, target) - rowBlobBytes(compact, target))
  }
  return { planned_reclaimed_blob_bytes: planned, schema_histogram: histogram }
}

export async function buildAuditJsonRetentionPlan(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  options: {
    businessDate?: string | null
    retentionDays?: number
    targets?: Array<string | null | undefined> | null
    minBlobBytes?: number
  } = {},
): Promise<AuditJsonRetentionPlan> {
  const businessDate = normalizeBusinessDate(options.businessDate)
  const retentionDays = clampInt(
    options.retentionDays,
    AUDIT_JSON_RETENTION_DEFAULT_DAYS,
    AUDIT_JSON_RETENTION_MIN_DAYS,
    AUDIT_JSON_RETENTION_MAX_DAYS,
  )
  const cutoffDate = isoDateOffset(businessDate, -retentionDays)
  const minBlobBytes = clampInt(options.minBlobBytes, AUDIT_JSON_ARCHIVE_MIN_BLOB_BYTES, 1, 1_000_000)
  const tables: AuditJsonRetentionPlanTable[] = []
  const targets = selectedTargets(options.targets)
  // A full-table COUNT/SUM over strategy_decision_log exceeds D1's statement
  // limits (7500); the bounded dry-run page reports the opt-in plan instead.
  if (targets.some((target) => target.optIn)) throw new Error('audit_json_plan_unbounded_use_dry_run')

  for (const target of targets) {
    const targetDb = databaseForTable(env, target.table)
    const row = await targetDb.prepare(`
      SELECT COUNT(*) AS cold_rows,
             SUM(CASE WHEN ${archiveableWhere(target)} THEN 1 ELSE 0 END) AS archiveable_rows,
             MIN(${target.dateColumn}) AS min_date,
             MAX(${target.dateColumn}) AS max_date,
             SUM(CASE WHEN ${archiveableWhere(target)} THEN (${blobLengthExpr(target)}) ELSE 0 END) AS archiveable_blob_bytes
       FROM ${target.table}
       WHERE ${target.dateColumn} IS NOT NULL
         AND ${target.dateColumn} < ?
         AND (${retentionEligibilityWhere(target)})
    `).bind(
      ...archiveableBinds(target, minBlobBytes),
      ...archiveableBinds(target, minBlobBytes),
      cutoffDate,
    ).first<{
      cold_rows?: number
      archiveable_rows?: number
      min_date?: string | null
      max_date?: string | null
      archiveable_blob_bytes?: number
    }>()

    tables.push({
      target: target.id,
      table: target.table,
      date_column: target.dateColumn,
      cutoff_date: cutoffDate,
      retention_days: retentionDays,
      cold_rows: Number(row?.cold_rows ?? 0),
      archiveable_rows: Number(row?.archiveable_rows ?? 0),
      min_date: row?.min_date ?? null,
      max_date: row?.max_date ?? null,
      archiveable_blob_bytes: Number(row?.archiveable_blob_bytes ?? 0),
      action: 'archive_to_r2_then_scrub_json_columns',
      dry_run: true,
    })
  }

  return {
    dry_run: true,
    archive_kind: AUDIT_JSON_ARCHIVE_KIND,
    business_date: businessDate,
    retention_days: retentionDays,
    cutoff_date: cutoffDate,
    min_blob_bytes: minBlobBytes,
    tables,
    total_archiveable_rows: tables.reduce((sum, table) => sum + table.archiveable_rows, 0),
    total_archiveable_blob_bytes: tables.reduce((sum, table) => sum + table.archiveable_blob_bytes, 0),
    note: 'Dry-run only. Confirmed archive writes full JSON payloads to R2, then replaces D1 JSON columns with compact R2 pointers.',
  }
}

export async function runAuditJsonArchiveRetention(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'> & Partial<Bindings>,
  options: {
    businessDate?: string | null
    runId?: string | null
    retentionDays?: number
    limitPerTable?: number
    targets?: Array<string | null | undefined> | null
    minBlobBytes?: number
    dryRun?: boolean
    confirmPhrase?: string | null
  } = {},
): Promise<AuditJsonArchiveRunResult> {
  const businessDate = normalizeBusinessDate(options.businessDate)
  const retentionDays = clampInt(
    options.retentionDays,
    AUDIT_JSON_RETENTION_DEFAULT_DAYS,
    AUDIT_JSON_RETENTION_MIN_DAYS,
    AUDIT_JSON_RETENTION_MAX_DAYS,
  )
  const runCutoffDate = isoDateOffset(businessDate, -retentionDays)
  const minBlobBytes = clampInt(options.minBlobBytes, AUDIT_JSON_ARCHIVE_MIN_BLOB_BYTES, 1, 1_000_000)
  const limitPerTable = clampInt(
    options.limitPerTable,
    AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE,
    1,
    AUDIT_JSON_ARCHIVE_MAX_LIMIT_PER_TABLE,
  )
  const runId = cleanRunPart(String(options.runId || `audit-json-retention-${businessDate}-${Date.now().toString(36)}`))
  const dryRun = options.dryRun !== false || options.confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE
  const archivedAt = new Date().toISOString()
  const opsDb = databaseForDataDomain(env, 'ops')

  const result: AuditJsonArchiveRunResult = {
    dry_run: dryRun,
    archive_kind: AUDIT_JSON_ARCHIVE_KIND,
    business_date: businessDate,
    run_id: runId,
    retention_days: retentionDays,
    cutoff_date: runCutoffDate,
    limit_per_table: limitPerTable,
    tables: [],
    total_archived_rows: 0,
    total_scrubbed_rows: 0,
    total_archived_blob_bytes: 0,
  }

  // The KV gate is the kill switch for opt-in targets: read on every attempt,
  // and a closed gate writes nothing (no R2, manifest, ledger or source row).
  const requestedTargets = selectedTargets(options.targets)
  const refV2Gate = requestedTargets.some((target) => target.optIn) ? await readAuditJsonRefV2Gate(env.KV) : null
  const runnableTargets = requestedTargets.filter((target) => !target.optIn || refV2Gate)
  for (const target of requestedTargets.filter((target) => target.optIn && !refV2Gate)) {
    result.tables.push({
      target: target.id, table: target.table, candidate_rows: 0, archived_rows: 0, scrubbed_rows: 0,
      archived_blob_bytes: 0, r2_key: null, snapshot_id: null, checksum: null, status: 'skipped',
      cursor_date: null, cursor_key: null, backlog_remaining: false, skipped_reason: 'ref_v2_gate_off',
    })
  }
  if (!runnableTargets.length) return result

  if (!dryRun && !env.ARTIFACTS) {
    throw new Error('audit_json_archive_r2_binding_missing')
  }
  if (!dryRun) {
    await beginRetentionRun(opsDb, {
      runId,
      policyId: AUDIT_JSON_RETENTION_POLICY_ID,
      businessDate,
    })
  }

  for (const target of runnableTargets) {
    const refV2 = target.mode === 'ref_v2_move'
    // ref-v2 ignores retention_days/min_blob_bytes: it compacts every row older
    // than its hot window, independent of the scheduler's 30-day audit window.
    const cutoffDate = refV2
      ? isoDateOffset(businessDate, -(target.hotDays ?? STRATEGY_DECISION_REF_V2_HOT_DAYS))
      : runCutoffDate
    const targetDb = databaseForTable(env, target.table)
    const cursor = dryRun
      ? null
      : await loadRetentionCursor(opsDb, AUDIT_JSON_RETENTION_POLICY_ID, target.id)
    let candidates = await loadCandidateRows(targetDb, target, cutoffDate, limitPerTable, minBlobBytes, cursor)
    let rows = candidates.rows
    // Keyset cursors are only a scan accelerator. Rows can become eligible after
    // the cursor passed them (for example after evidence migration or parity
    // protection is lifted), so a tail miss must re-check the head once.
    if (!dryRun && rows.length === 0 && cursor?.backlog_remaining && cursor.cursor_date) {
      candidates = await loadCandidateRows(targetDb, target, cutoffDate, limitPerTable, minBlobBytes, null)
      rows = candidates.rows
    }
    const archivedBlobBytes = rows.reduce((sum, row) => sum + rowBlobBytes(row, target), 0)
    if (dryRun || rows.length === 0) {
      result.tables.push({
        target: target.id,
        table: target.table,
        candidate_rows: rows.length,
        archived_rows: 0,
        scrubbed_rows: 0,
        archived_blob_bytes: archivedBlobBytes,
        r2_key: null,
        snapshot_id: null,
        checksum: null,
        status: dryRun ? 'dry_run' : 'skipped',
        cursor_date: cursor?.cursor_date ?? null,
        cursor_key: cursor?.cursor_key ?? null,
        backlog_remaining: candidates.hasMore,
        ...(refV2 ? { cutoff_date: cutoffDate, ...(dryRun ? refV2PlanStats(target, rows) : {}) } : {}),
      })
      if (!dryRun) {
        await checkpointRetentionItem(opsDb, {
          runId,
          policyId: AUDIT_JSON_RETENTION_POLICY_ID,
          datasetId: target.id,
          status: 'skipped',
          scannedRows: 0,
          backlogRemaining: false,
          cycleComplete: true,
          evidence: { cutoff_date: cutoffDate, reason: 'no_more_eligible_rows' },
        })
      }
      continue
    }

    let phase = 'archive_prepare'
    let partialScrubEvidence: Record<string, unknown> | null = null
    try {
      // Checked before any R2/manifest write: the rowid move is only collision-free
      // when every statement of the attempt lands in one atomic db.batch.
      if (refV2 && Math.ceil(rows.length / auditJsonRowsPerUpdateStatement(target.blobColumns.length)) > REF_V2_MAX_STATEMENTS_PER_ATTEMPT) {
        throw new Error('ref_v2_batch_not_atomic')
      }
      const chunkId = cleanRunPart(`${rows[0]?.[target.keyColumn] ?? 'start'}-${rows[rows.length - 1]?.[target.keyColumn] ?? 'end'}`)
      const r2KeyPrefix = [
        'archives',
        AUDIT_JSON_ARCHIVE_KIND,
        `target=${target.id}`,
        `business_date=${businessDate}`,
        `run_id=${runId}`,
        `cutoff_date=${cutoffDate}`,
        `chunk=${chunkId}.json`,
      ].join('/')
      const payload = {
        schema_version: 'd1-audit-json-archive-v1',
        archive_kind: AUDIT_JSON_ARCHIVE_KIND,
        target: target.id,
        table: target.table,
        date_column: target.dateColumn,
        key_column: target.keyColumn,
        blob_columns: target.blobColumns,
        business_date: businessDate,
        retention_days: retentionDays,
        cutoff_date: cutoffDate,
        ...(refV2 ? { hot_days: target.hotDays, rowid_moved: true } : {}),
        archived_at: archivedAt,
        row_count: rows.length,
        blob_bytes: archivedBlobBytes,
        rows: rows.map((row) => {
          const copy = { ...row }
          delete copy.__blob_bytes
          return copy
        }),
      }
      const body = JSON.stringify(payload)
      const checksum = await sha256Text(body)
      const r2Key = r2KeyPrefix.replace(/\.json$/, `-${checksum}.json`)
      const snapshotId = `${AUDIT_JSON_ARCHIVE_KIND}:${target.id}:${businessDate}:${runId}:${chunkId}:${checksum}`
      const compacted = new Map<Record<string, unknown>, Record<string, unknown>>()
      let reclaimedBlobBytes = 0
      for (const row of rows) {
        const pointers = refV2
          ? compactRefV2Row(row, target.blobColumns, refV2ArchiveDigest(checksum))
          : Object.fromEntries(target.blobColumns.map(blobColumn => [blobColumn, compactBlob(target, row[blobColumn], {
            table: target.table, keyColumn: target.keyColumn, keyValue: rowKey(row, target),
            blobColumn, snapshotId, r2Key, checksum, archivedAt,
            originalByteLength: byteLength(row[blobColumn]),
          })]))
        const saved = rowBlobBytes(row, target) - rowBlobBytes(pointers, target)
        // ref-v2 also moves rows that only gained the marker, so they leave the backlog.
        if (saved > 0 || (refV2 && target.blobColumns.some(column => pointers[column] !== row[column]))) {
          compacted.set(row, pointers)
          reclaimedBlobBytes += Math.max(0, saved)
        }
      }
      const rowsToScrub = rows.filter(row => compacted.has(row))
      const lastRow = rows[rows.length - 1]
      const backlogRemaining = candidates.hasMore
      const skippedNoSavingsRows = rows.length - rowsToScrub.length
      if (!rowsToScrub.length) {
        // Advance past an unprofitable page without creating another archive,
        // manifest or source UPDATE. A later scan may re-evaluate changed rows.
        result.tables.push({
          target: target.id, table: target.table, candidate_rows: rows.length,
          archived_rows: 0, scrubbed_rows: 0, archived_blob_bytes: 0,
          reclaimed_blob_bytes: 0, skipped_no_savings_rows: skippedNoSavingsRows,
          r2_key: null, snapshot_id: null, checksum: null, status: 'skipped',
          cursor_date: String(lastRow?.[target.dateColumn] ?? '') || null,
          cursor_key: String(lastRow?.[target.keyColumn] ?? '') || null,
          backlog_remaining: backlogRemaining,
        })
        phase = 'checkpoint'
        await checkpointRetentionItem(opsDb, {
          runId, policyId: AUDIT_JSON_RETENTION_POLICY_ID, datasetId: target.id,
          status: 'skipped', scannedRows: rows.length,
          cursorDate: String(lastRow?.[target.dateColumn] ?? '') || null,
          cursorKey: lastRow?.[target.keyColumn] as string | number | null,
          backlogRemaining, cycleComplete: !backlogRemaining,
          evidence: { cutoff_date: cutoffDate, reason: 'no_safe_storage_saving', skipped_no_savings_rows: skippedNoSavingsRows },
        })
        continue
      }

      phase = 'archive_readback'
      let readback = await env.ARTIFACTS!.get(r2Key)
      if (!readback) {
        phase = 'archive_put'
        try {
          await env.ARTIFACTS!.put(r2Key, body, {
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            customMetadata: { checksum, minimum_retention_days: '3650' },
            onlyIf: { etagDoesNotMatch: '*' },
          })
        } catch (error) {
          phase = 'archive_readback'
          readback = await env.ARTIFACTS!.get(r2Key)
          if (!readback) {
            phase = 'archive_put'
            throw error
          }
        }
        phase = 'archive_readback'
        readback ??= await env.ARTIFACTS!.get(r2Key)
      }
      if (!readback) throw new Error('audit_json_archive_readback_missing')
      if (await sha256Text(await readback.text()) !== checksum)
        throw new Error('audit_json_archive_checksum_mismatch')

      phase = 'manifest'
      const manifest: DatasetSnapshotManifest = {
        snapshot_id: snapshotId,
        kind: AUDIT_JSON_ARCHIVE_KIND,
        business_date: businessDate,
        market_segment: null,
        schema_version: 'd1-audit-json-archive-v1',
        row_count: rows.length,
        checksum,
        primary_store: 'r2',
        access_tier: 'archive',
        gcs_uri: null,
        r2_key: r2Key,
        producer_run_id: runId,
        status: 'ready',
        metadata_json: JSON.stringify({
          role: 'd1_audit_json_r2_archive',
          target: target.id,
          table: target.table,
          date_column: target.dateColumn,
          key_column: target.keyColumn,
          blob_columns: target.blobColumns,
          retention_days: retentionDays,
          cutoff_date: cutoffDate,
          coverage_start: rows[0]?.[target.dateColumn] ?? null,
          coverage_end: rows[rows.length - 1]?.[target.dateColumn] ?? null,
          archived_blob_bytes: archivedBlobBytes,
          planned_reclaimed_blob_bytes: reclaimedBlobBytes,
          skipped_no_savings_rows: skippedNoSavingsRows,
          retention_action: refV2 ? 'compact_json_columns_to_ref_v2_and_move_rowid' : 'scrub_json_columns_to_r2_pointer',
          ...(refV2 ? { ref_v2_schema: AUDIT_JSON_REF_V2_SCHEMA, hot_days: target.hotDays, rowid_moved: true } : {}),
          minimum_cold_days: 3650,
          retain_until: new Date(Date.parse(archivedAt) + 3650 * 86400_000).toISOString(),
          readback_verified_at: new Date().toISOString(),
        }),
      }
      await upsertDatasetSnapshotManifest(env, manifest)

      phase = 'scrub'
      const sizeBefore = refV2 ? await d1SizeAfter(targetDb) : null
      const scrubStartedAt = Date.now()
      // Per-attempt physical size receipt: the pilot calibrates file bytes freed
      // per moved row from these deltas net of the between-attempt write slope.
      const sizeReceipt = async () => ({
        d1_size_before: sizeBefore,
        d1_size_after: await d1SizeAfter(targetDb),
        scrub_ms: Date.now() - scrubStartedAt,
        ...(await refV2RowidMap(targetDb, target, rowsToScrub)),
      })
      let scrubbed: number
      try {
        scrubbed = await scrubArchivedRows(targetDb, target, rowsToScrub, cutoffDate,
          (row, blobColumn) => compacted.get(row)![blobColumn])
      } catch (error) {
        // A CAS miss commits the rows that still matched before it throws; keep their receipt.
        if (refV2) partialScrubEvidence = await sizeReceipt()
        throw error
      }
      const refV2Evidence = refV2 ? await sizeReceipt() : null
      result.tables.push({
        target: target.id,
        table: target.table,
        candidate_rows: rows.length,
        archived_rows: rows.length,
        scrubbed_rows: scrubbed,
        archived_blob_bytes: archivedBlobBytes,
        reclaimed_blob_bytes: reclaimedBlobBytes,
        skipped_no_savings_rows: skippedNoSavingsRows,
        r2_key: r2Key,
        snapshot_id: snapshotId,
        checksum,
        status: 'archived',
        cursor_date: String(lastRow?.[target.dateColumn] ?? '') || null,
        cursor_key: String(lastRow?.[target.keyColumn] ?? '') || null,
        backlog_remaining: backlogRemaining,
        ...(refV2Evidence ? {
          cutoff_date: cutoffDate,
          d1_size_before: refV2Evidence.d1_size_before,
          d1_size_after: refV2Evidence.d1_size_after,
        } : {}),
      })
      result.total_archived_rows += rows.length
      result.total_scrubbed_rows += scrubbed
      result.total_archived_blob_bytes += archivedBlobBytes
      phase = 'checkpoint'
      await checkpointRetentionItem(opsDb, {
        runId,
        policyId: AUDIT_JSON_RETENTION_POLICY_ID,
        datasetId: target.id,
        status: 'success',
        scannedRows: rows.length,
        archivedRows: rows.length,
        scrubbedRows: scrubbed,
        archivedBytes: archivedBlobBytes,
        cursorDate: String(lastRow?.[target.dateColumn] ?? '') || null,
        cursorKey: lastRow?.[target.keyColumn] as string | number | null,
        backlogRemaining,
        cycleComplete: !backlogRemaining,
        evidence: { snapshot_id: snapshotId, r2_key: r2Key, checksum, cutoff_date: cutoffDate,
          reclaimed_blob_bytes: reclaimedBlobBytes, skipped_no_savings_rows: skippedNoSavingsRows,
          ...(refV2Evidence ?? {}) },
      })
    } catch (error) {
      const message = `audit_json_phase=${phase} ${error instanceof Error ? error.message : String(error)}`
      result.tables.push({
        target: target.id,
        table: target.table,
        candidate_rows: rows.length,
        archived_rows: 0,
        scrubbed_rows: 0,
        archived_blob_bytes: archivedBlobBytes,
        r2_key: null,
        snapshot_id: null,
        checksum: null,
        status: 'failed',
        cursor_date: cursor?.cursor_date ?? null,
        cursor_key: cursor?.cursor_key ?? null,
        backlog_remaining: true,
        error: message,
        ...(partialScrubEvidence ? {
          cutoff_date: cutoffDate,
          scrubbed_rows: Number(partialScrubEvidence.moved_rows ?? 0),
          d1_size_before: partialScrubEvidence.d1_size_before as number | null,
          d1_size_after: partialScrubEvidence.d1_size_after as number | null,
        } : {}),
      })
      result.total_scrubbed_rows += Number(partialScrubEvidence?.moved_rows ?? 0)
      if (!dryRun) {
        await checkpointRetentionItem(opsDb, {
          runId,
          policyId: AUDIT_JSON_RETENTION_POLICY_ID,
          datasetId: target.id,
          status: 'error',
          scrubbedRows: Number(partialScrubEvidence?.moved_rows ?? 0),
          cursorDate: cursor?.cursor_date ?? null,
          cursorKey: cursor?.cursor_key ?? null,
          backlogRemaining: true,
          error: message,
          ...(partialScrubEvidence ? { evidence: { cutoff_date: cutoffDate, partial_commit: true, ...partialScrubEvidence } } : {}),
        })
      }
    }
  }

  if (!dryRun) {
    const failed = result.tables.filter((table) => table.status === 'failed')
    await finishRetentionRun(opsDb, {
      runId,
      status: failed.length ? 'error' : 'success',
      scannedRows: result.tables.reduce((sum, table) => sum + table.candidate_rows, 0),
      archivedRows: result.total_archived_rows,
      scrubbedRows: result.total_scrubbed_rows,
      archivedBytes: result.total_archived_blob_bytes,
      error: failed.map((table) => `${table.target}:${table.error ?? 'unknown'}`).join('; ') || null,
    })
  }
  return result
}

export function summarizeAuditJsonArchiveRun(result: AuditJsonArchiveRunResult): string {
  const mode = result.dry_run ? 'dry_run' : 'confirmed'
  const tableSummary = result.tables
    .map((table) => `${table.target}:${table.status}:candidates=${table.candidate_rows}:archived=${table.archived_rows}:scrubbed=${table.scrubbed_rows}${table.cutoff_date ? `:cutoff=${table.cutoff_date}` : ''}`)
    .join(' ')
  return `audit-json-retention ${mode} date=${result.business_date} cutoff=${result.cutoff_date} retention_days=${result.retention_days} total_archived=${result.total_archived_rows} total_scrubbed=${result.total_scrubbed_rows} bytes=${result.total_archived_blob_bytes}; ${tableSummary}`
}

export function isAuditJsonArchiveTarget(value: string): value is AuditJsonArchiveTargetId {
  return TARGET_BY_ID.has(value as AuditJsonArchiveTargetId)
}
