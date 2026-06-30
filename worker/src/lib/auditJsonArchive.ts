import type { Bindings } from '../types'
import {
  sha256Text,
  upsertDatasetSnapshotManifest,
  type DatasetSnapshotManifest,
} from './datasetSnapshots'

export const AUDIT_JSON_ARCHIVE_KIND = 'd1_audit_json_archive'
export const AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE = 'ARCHIVE_D1_AUDIT_JSON_TO_R2'
export const AUDIT_JSON_RETENTION_DEFAULT_DAYS = 90
export const AUDIT_JSON_RETENTION_MIN_DAYS = 30
export const AUDIT_JSON_RETENTION_MAX_DAYS = 3650
export const AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE = 250
export const AUDIT_JSON_ARCHIVE_MAX_LIMIT_PER_TABLE = 1000

export type AuditJsonArchiveTargetId =
  | 'paper_execution_events'
  | 'strategy_decision_log'
  | 'screener_funnel_items'

type AuditJsonTargetConfig = {
  id: AuditJsonArchiveTargetId
  table: AuditJsonArchiveTargetId
  dateColumn: string
  keyColumn: string
  selectedColumns: string[]
  blobColumns: string[]
}

export type AuditJsonRetentionPlanTable = {
  table: AuditJsonArchiveTargetId
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
    table: AuditJsonArchiveTargetId
    candidate_rows: number
    archived_rows: number
    scrubbed_rows: number
    archived_blob_bytes: number
    r2_key: string | null
    snapshot_id: string | null
    checksum: string | null
    status: 'dry_run' | 'archived' | 'skipped' | 'failed'
    error?: string
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
]

const TARGET_BY_ID = new Map(AUDIT_JSON_TARGETS.map((target) => [target.id, target]))

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
  if (!targets?.length) return AUDIT_JSON_TARGETS
  const selected = new Set(
    targets
      .flatMap((raw) => String(raw ?? '').split(','))
      .map((raw) => raw.trim())
      .filter(Boolean),
  )
  if (!selected.size) return AUDIT_JSON_TARGETS
  return AUDIT_JSON_TARGETS.filter((target) => selected.has(target.id))
}

function blobLengthExpr(target: AuditJsonTargetConfig): string {
  return target.blobColumns.map((column) => `LENGTH(COALESCE(${column}, ''))`).join(' + ')
}

function archiveableWhere(target: AuditJsonTargetConfig): string {
  return target.blobColumns
    .map((column) => `(
      LENGTH(COALESCE(${column}, '')) > ?
      AND COALESCE(${column}, '') NOT LIKE '%"archived_to_r2":true%'
    )`)
    .join(' OR ')
}

function archiveableBinds(target: AuditJsonTargetConfig, minBlobBytes: number): unknown[] {
  return target.blobColumns.map(() => minBlobBytes)
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

function buildPointer(input: {
  table: string
  keyColumn: string
  keyValue: string | number
  blobColumn: string
  snapshotId: string
  r2Key: string
  checksum: string
  archivedAt: string
  originalByteLength: number
}): string {
  return JSON.stringify({
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

async function loadCandidateRows(
  env: Pick<Bindings, 'DB'>,
  target: AuditJsonTargetConfig,
  cutoffDate: string,
  limit: number,
  minBlobBytes: number,
): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(`
    SELECT ${target.selectedColumns.join(', ')},
           (${blobLengthExpr(target)}) AS __blob_bytes
      FROM ${target.table}
     WHERE ${target.dateColumn} IS NOT NULL
       AND ${target.dateColumn} < ?
       AND (${archiveableWhere(target)})
     ORDER BY ${target.dateColumn} ASC, ${target.keyColumn} ASC
     LIMIT ?
  `).bind(cutoffDate, ...archiveableBinds(target, minBlobBytes), limit).all<Record<string, unknown>>()
  return results ?? []
}

async function scrubArchivedRows(
  env: Pick<Bindings, 'DB'>,
  target: AuditJsonTargetConfig,
  rows: Record<string, unknown>[],
  pointerFor: (row: Record<string, unknown>, blobColumn: string) => string,
): Promise<number> {
  if (!rows.length) return 0
  const setClause = target.blobColumns.map((column) => `${column} = ?`).join(', ')
  const statements: D1PreparedStatement[] = []
  for (const row of rows) {
    const key = rowKey(row, target)
    statements.push(
      env.DB.prepare(`
        UPDATE ${target.table}
           SET ${setClause}
         WHERE ${target.keyColumn} = ?
      `).bind(
        ...target.blobColumns.map((column) => pointerFor(row, column)),
        key,
      ),
    )
  }
  let updated = 0
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50))
    updated += statements.slice(i, i + 50).length
  }
  return updated
}

export async function buildAuditJsonRetentionPlan(
  env: Pick<Bindings, 'DB'>,
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
  const minBlobBytes = clampInt(options.minBlobBytes, 64, 1, 1_000_000)
  const tables: AuditJsonRetentionPlanTable[] = []

  for (const target of selectedTargets(options.targets)) {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS cold_rows,
             SUM(CASE WHEN ${archiveableWhere(target)} THEN 1 ELSE 0 END) AS archiveable_rows,
             MIN(${target.dateColumn}) AS min_date,
             MAX(${target.dateColumn}) AS max_date,
             SUM(CASE WHEN ${archiveableWhere(target)} THEN (${blobLengthExpr(target)}) ELSE 0 END) AS archiveable_blob_bytes
        FROM ${target.table}
       WHERE ${target.dateColumn} IS NOT NULL
         AND ${target.dateColumn} < ?
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
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
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
  const cutoffDate = isoDateOffset(businessDate, -retentionDays)
  const minBlobBytes = clampInt(options.minBlobBytes, 64, 1, 1_000_000)
  const limitPerTable = clampInt(
    options.limitPerTable,
    AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE,
    1,
    AUDIT_JSON_ARCHIVE_MAX_LIMIT_PER_TABLE,
  )
  const runId = cleanRunPart(String(options.runId || `audit-json-retention-${businessDate}-${Date.now().toString(36)}`))
  const dryRun = options.dryRun !== false || options.confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE
  const archivedAt = new Date().toISOString()

  const result: AuditJsonArchiveRunResult = {
    dry_run: dryRun,
    archive_kind: AUDIT_JSON_ARCHIVE_KIND,
    business_date: businessDate,
    run_id: runId,
    retention_days: retentionDays,
    cutoff_date: cutoffDate,
    limit_per_table: limitPerTable,
    tables: [],
    total_archived_rows: 0,
    total_scrubbed_rows: 0,
    total_archived_blob_bytes: 0,
  }

  if (!dryRun && !env.ARTIFACTS) {
    throw new Error('audit_json_archive_r2_binding_missing')
  }

  for (const target of selectedTargets(options.targets)) {
    const rows = await loadCandidateRows(env, target, cutoffDate, limitPerTable, minBlobBytes)
    const archivedBlobBytes = rows.reduce((sum, row) => sum + rowBlobBytes(row, target), 0)
    if (dryRun || rows.length === 0) {
      result.tables.push({
        table: target.table,
        candidate_rows: rows.length,
        archived_rows: 0,
        scrubbed_rows: 0,
        archived_blob_bytes: archivedBlobBytes,
        r2_key: null,
        snapshot_id: null,
        checksum: null,
        status: dryRun ? 'dry_run' : 'skipped',
      })
      continue
    }

    try {
      const chunkId = cleanRunPart(`${rows[0]?.[target.keyColumn] ?? 'start'}-${rows[rows.length - 1]?.[target.keyColumn] ?? 'end'}`)
      const r2Key = [
        'archives',
        AUDIT_JSON_ARCHIVE_KIND,
        `table=${target.table}`,
        `business_date=${businessDate}`,
        `run_id=${runId}`,
        `cutoff_date=${cutoffDate}`,
        `chunk=${chunkId}.json`,
      ].join('/')
      const payload = {
        schema_version: 'd1-audit-json-archive-v1',
        archive_kind: AUDIT_JSON_ARCHIVE_KIND,
        table: target.table,
        date_column: target.dateColumn,
        key_column: target.keyColumn,
        blob_columns: target.blobColumns,
        business_date: businessDate,
        retention_days: retentionDays,
        cutoff_date: cutoffDate,
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
      const snapshotId = `${AUDIT_JSON_ARCHIVE_KIND}:${target.table}:${businessDate}:${runId}:${chunkId}`

      await (env.ARTIFACTS as any).put(r2Key, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      })

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
          table: target.table,
          date_column: target.dateColumn,
          key_column: target.keyColumn,
          blob_columns: target.blobColumns,
          retention_days: retentionDays,
          cutoff_date: cutoffDate,
          coverage_start: rows[0]?.[target.dateColumn] ?? null,
          coverage_end: rows[rows.length - 1]?.[target.dateColumn] ?? null,
          archived_blob_bytes: archivedBlobBytes,
          retention_action: 'scrub_json_columns_to_r2_pointer',
        }),
      }
      await upsertDatasetSnapshotManifest(env, manifest)

      const scrubbed = await scrubArchivedRows(env, target, rows, (row, blobColumn) => buildPointer({
        table: target.table,
        keyColumn: target.keyColumn,
        keyValue: rowKey(row, target),
        blobColumn,
        snapshotId,
        r2Key,
        checksum,
        archivedAt,
        originalByteLength: byteLength(row[blobColumn]),
      }))

      result.tables.push({
        table: target.table,
        candidate_rows: rows.length,
        archived_rows: rows.length,
        scrubbed_rows: scrubbed,
        archived_blob_bytes: archivedBlobBytes,
        r2_key: r2Key,
        snapshot_id: snapshotId,
        checksum,
        status: 'archived',
      })
      result.total_archived_rows += rows.length
      result.total_scrubbed_rows += scrubbed
      result.total_archived_blob_bytes += archivedBlobBytes
    } catch (error) {
      result.tables.push({
        table: target.table,
        candidate_rows: rows.length,
        archived_rows: 0,
        scrubbed_rows: 0,
        archived_blob_bytes: archivedBlobBytes,
        r2_key: null,
        snapshot_id: null,
        checksum: null,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

export function summarizeAuditJsonArchiveRun(result: AuditJsonArchiveRunResult): string {
  const mode = result.dry_run ? 'dry_run' : 'confirmed'
  const tableSummary = result.tables
    .map((table) => `${table.table}:${table.status}:candidates=${table.candidate_rows}:archived=${table.archived_rows}:scrubbed=${table.scrubbed_rows}`)
    .join(' ')
  return `audit-json-retention ${mode} date=${result.business_date} cutoff=${result.cutoff_date} retention_days=${result.retention_days} total_archived=${result.total_archived_rows} total_scrubbed=${result.total_scrubbed_rows} bytes=${result.total_archived_blob_bytes}; ${tableSummary}`
}

export function isAuditJsonArchiveTarget(value: string): value is AuditJsonArchiveTargetId {
  return TARGET_BY_ID.has(value as AuditJsonArchiveTargetId)
}
