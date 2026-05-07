import type { Bindings } from '../types'

export type SnapshotPrimaryStore = 'd1' | 'gcs' | 'r2'
export type SnapshotAccessTier = 'serving' | 'compute' | 'report' | 'preview' | 'archive'
export type SnapshotStatus = 'pending' | 'ready' | 'failed' | 'expired'

export type DatasetSnapshotManifest = {
  snapshot_id: string
  kind: string
  business_date: string
  market_segment?: string | null
  schema_version: string
  row_count: number
  checksum: string
  primary_store: SnapshotPrimaryStore
  access_tier: SnapshotAccessTier
  gcs_uri?: string | null
  r2_key?: string | null
  producer_run_id: string
  status: SnapshotStatus
  metadata_json?: string | null
  created_at?: string
  updated_at?: string
}

export type SnapshotStoreRole = {
  primary_store: SnapshotPrimaryStore
  access_tier: SnapshotAccessTier
  requires_gcs: boolean
  requires_r2: boolean
  reason: string
}

const STORE_ROLE_BY_ACCESS_TIER: Record<SnapshotAccessTier, SnapshotStoreRole> = {
  serving: {
    primary_store: 'd1',
    access_tier: 'serving',
    requires_gcs: false,
    requires_r2: false,
    reason: 'Serving state stays in D1 for low-latency UI and trading reads.',
  },
  compute: {
    primary_store: 'gcs',
    access_tier: 'compute',
    requires_gcs: true,
    requires_r2: false,
    reason: 'ML, Modal, backtest, Optuna, CPCV, and PBO compute read GCS snapshots.',
  },
  report: {
    primary_store: 'r2',
    access_tier: 'report',
    requires_gcs: false,
    requires_r2: true,
    reason: 'Human-readable OBS, report, and dashboard artifacts are read from R2.',
  },
  preview: {
    primary_store: 'r2',
    access_tier: 'preview',
    requires_gcs: false,
    requires_r2: true,
    reason: 'Frontend drilldown previews use R2 instead of scanning D1 history.',
  },
  archive: {
    primary_store: 'r2',
    access_tier: 'archive',
    requires_gcs: false,
    requires_r2: true,
    reason: 'Cold audit artifacts are object-store records, not D1 serving rows.',
  },
}

export function resolveSnapshotStoreRole(accessTier: SnapshotAccessTier): SnapshotStoreRole {
  return STORE_ROLE_BY_ACCESS_TIER[accessTier] ?? STORE_ROLE_BY_ACCESS_TIER.preview
}

export function validateDatasetSnapshotManifest(row: Partial<DatasetSnapshotManifest>): string[] {
  const errors: string[] = []
  const role = row.access_tier ? resolveSnapshotStoreRole(row.access_tier) : null

  if (!row.snapshot_id) errors.push('snapshot_id_missing')
  if (!row.kind) errors.push('kind_missing')
  if (!row.business_date) errors.push('business_date_missing')
  if (!row.schema_version) errors.push('schema_version_missing')
  if (!row.checksum) errors.push('checksum_missing')
  if (!row.producer_run_id) errors.push('producer_run_id_missing')
  if (!row.access_tier) errors.push('access_tier_missing')
  if (!row.primary_store) errors.push('primary_store_missing')
  if (row.row_count == null || Number(row.row_count) < 0) errors.push('row_count_invalid')
  if (role && row.primary_store !== role.primary_store) {
    errors.push(`primary_store_mismatch:${row.primary_store}->${role.primary_store}`)
  }
  if (role?.requires_gcs && !row.gcs_uri) errors.push('gcs_uri_required')
  if (role?.requires_r2 && !row.r2_key) errors.push('r2_key_required')
  return errors
}

export type SnapshotListFilters = {
  kind?: string
  businessDate?: string
  accessTier?: SnapshotAccessTier
  limit?: number
}

function capLimit(limit: unknown, fallback = 50): number {
  const n = Number(limit)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(Math.trunc(n), 200))
}

export async function listDatasetSnapshots(
  env: Pick<Bindings, 'DB'>,
  filters: SnapshotListFilters = {},
): Promise<Array<DatasetSnapshotManifest & { manifest_errors: string[] }>> {
  const where: string[] = ['1=1']
  const params: unknown[] = []

  if (filters.kind) {
    where.push('kind = ?')
    params.push(filters.kind)
  }
  if (filters.businessDate) {
    where.push('business_date = ?')
    params.push(filters.businessDate)
  }
  if (filters.accessTier) {
    where.push('access_tier = ?')
    params.push(filters.accessTier)
  }

  const sql = `
    SELECT *
    FROM dataset_snapshots
    WHERE ${where.join(' AND ')}
    ORDER BY business_date DESC, created_at DESC
    LIMIT ?
  `
  const { results } = await env.DB.prepare(sql).bind(...params, capLimit(filters.limit)).all<DatasetSnapshotManifest>()
  return (results ?? []).map((row) => ({
    ...row,
    manifest_errors: validateDatasetSnapshotManifest(row),
  }))
}

export async function getDatasetSnapshotManifest(
  env: Pick<Bindings, 'DB'>,
  snapshotId: string,
): Promise<(DatasetSnapshotManifest & { manifest_errors: string[] }) | null> {
  const row = await env.DB.prepare('SELECT * FROM dataset_snapshots WHERE snapshot_id = ? LIMIT 1')
    .bind(snapshotId)
    .first<DatasetSnapshotManifest>()
  if (!row) return null
  return { ...row, manifest_errors: validateDatasetSnapshotManifest(row) }
}

export async function readDatasetSnapshotPreview(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  snapshotId: string,
  byteLimit = 128 * 1024,
): Promise<Record<string, unknown>> {
  const manifest = await getDatasetSnapshotManifest(env, snapshotId)
  if (!manifest) return { found: false, reason: 'manifest_not_found' }
  if (!manifest.r2_key) return { found: true, available: false, manifest, reason: 'r2_key_missing' }
  if (!env.ARTIFACTS) return { found: true, available: false, manifest, reason: 'r2_binding_missing' }

  const object = await (env.ARTIFACTS as any).get(manifest.r2_key, {
    range: { offset: 0, length: Math.max(1, Math.min(byteLimit, 512 * 1024)) },
  })
  if (!object) return { found: true, available: false, manifest, reason: 'r2_object_not_found' }

  const text = await object.text()
  return {
    found: true,
    available: true,
    manifest,
    preview: text,
    truncated: Boolean(object.size && object.size > text.length),
    bytes_read: text.length,
    content_type: object.httpMetadata?.contentType ?? null,
  }
}

type D1ManifestSpec = {
  kind: string
  table: string
  dateColumn: string
  where?: string
}

const D1_HOT_WINDOW_MANIFESTS: D1ManifestSpec[] = [
  { kind: 'price_hot_window', table: 'stock_prices', dateColumn: 'date' },
  { kind: 'technical_indicator_hot_window', table: 'technical_indicators', dateColumn: 'date' },
  { kind: 'chip_hot_window', table: 'chip_data', dateColumn: 'date' },
  { kind: 'monthly_revenue_hot_window', table: 'monthly_revenue', dateColumn: 'date' },
]

const D1_RETENTION_TABLES: D1ManifestSpec[] = [
  { kind: 'price_hot_window', table: 'stock_prices', dateColumn: 'date' },
  { kind: 'technical_indicator_hot_window', table: 'technical_indicators', dateColumn: 'date' },
  { kind: 'chip_hot_window', table: 'chip_data', dateColumn: 'date' },
  { kind: 'prediction_hot_window', table: 'predictions', dateColumn: 'prediction_date' },
]

function d1ServingChecksum(kind: string, businessDate: string, rowCount: number, maxDate: string | null): string {
  return `d1:${kind}:${businessDate}:${maxDate ?? 'none'}:${rowCount}`
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256:${hex}`
}

async function upsertDatasetSnapshotManifest(
  env: Pick<Bindings, 'DB'>,
  manifest: DatasetSnapshotManifest,
): Promise<void> {
  const errors = validateDatasetSnapshotManifest(manifest)
  if (errors.length) {
    throw new Error(`dataset_snapshot_manifest_invalid:${manifest.kind}:${errors.join(',')}`)
  }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO dataset_snapshots (
      snapshot_id, kind, business_date, market_segment, schema_version,
      row_count, checksum, primary_store, access_tier, gcs_uri, r2_key,
      producer_run_id, status, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    manifest.snapshot_id,
    manifest.kind,
    manifest.business_date,
    manifest.market_segment ?? null,
    manifest.schema_version,
    manifest.row_count,
    manifest.checksum,
    manifest.primary_store,
    manifest.access_tier,
    manifest.gcs_uri ?? null,
    manifest.r2_key ?? null,
    manifest.producer_run_id,
    manifest.status,
    manifest.metadata_json ?? null,
  ).run()
}

export async function recordR2ReportArtifact(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  input: {
    kind: string
    businessDate: string
    producerRunId: string
    payload: Record<string, unknown>
  },
): Promise<DatasetSnapshotManifest | null> {
  if (!env.ARTIFACTS) return null

  const kind = input.kind.trim()
  const businessDate = input.businessDate.trim()
  const producerRunId = input.producerRunId.trim()
  if (!kind || !businessDate || !producerRunId) {
    throw new Error('r2_report_artifact_invalid_identity')
  }

  const body = JSON.stringify({
    ...input.payload,
    artifact_kind: kind,
    business_date: businessDate,
    producer_run_id: producerRunId,
    written_at: new Date().toISOString(),
  }, null, 2)
  const r2Key = `reports/${kind}/business_date=${businessDate}/run_id=${producerRunId}.json`
  await (env.ARTIFACTS as any).put(r2Key, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })

  const manifest: DatasetSnapshotManifest = {
    snapshot_id: `${kind}:${businessDate}:${producerRunId}`,
    kind,
    business_date: businessDate,
    market_segment: null,
    schema_version: 'r2-report-json-v1',
    row_count: 1,
    checksum: await sha256Text(body),
    primary_store: 'r2',
    access_tier: 'report',
    gcs_uri: null,
    r2_key: r2Key,
    producer_run_id: producerRunId,
    status: 'ready',
    metadata_json: JSON.stringify({
      role: 'r2_human_readable_report',
      content_type: 'application/json',
      byte_length: body.length,
    }),
  }
  await upsertDatasetSnapshotManifest(env, manifest)
  return manifest
}

function reportKindForTask(task: string): string {
  return `${task.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_run_report`
}

export async function recordSchedulerRunReportArtifact(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  input: {
    task: string
    status: string
    businessDate: string
    runId: string
    summary?: string
    durationMs?: number
    error?: string
    metadata?: Record<string, unknown>
  },
): Promise<DatasetSnapshotManifest | null> {
  return recordR2ReportArtifact(env, {
    kind: reportKindForTask(input.task),
    businessDate: input.businessDate,
    producerRunId: input.runId,
    payload: {
      task: input.task,
      status: input.status,
      summary: input.summary ?? '',
      duration_ms: input.durationMs ?? 0,
      error: input.error ?? null,
      metadata: input.metadata ?? {},
    },
  })
}

export async function recordD1HotWindowDatasetManifests(
  env: Pick<Bindings, 'DB'>,
  businessDate: string,
  producerRunId: string,
): Promise<Array<DatasetSnapshotManifest & { latest_date: string | null }>> {
  const written: Array<DatasetSnapshotManifest & { latest_date: string | null }> = []

  for (const spec of D1_HOT_WINDOW_MANIFESTS) {
    const where = spec.where ? `WHERE ${spec.where}` : ''
    const row = await env.DB.prepare(
      `SELECT MAX(${spec.dateColumn}) AS latest_date, COUNT(*) AS row_count FROM ${spec.table} ${where}`,
    ).first<{ latest_date: string | null; row_count: number }>()

    const latestDate = row?.latest_date ?? null
    const rowCount = Number(row?.row_count ?? 0)
    const manifest: DatasetSnapshotManifest = {
      snapshot_id: `${spec.kind}:${businessDate}:d1-serving`,
      kind: spec.kind,
      business_date: businessDate,
      market_segment: null,
      schema_version: 'd1-hot-window-v1',
      row_count: rowCount,
      checksum: d1ServingChecksum(spec.kind, businessDate, rowCount, latestDate),
      primary_store: 'd1',
      access_tier: 'serving',
      gcs_uri: null,
      r2_key: null,
      producer_run_id: producerRunId,
      status: latestDate ? 'ready' : 'failed',
      metadata_json: JSON.stringify({
        table: spec.table,
        date_column: spec.dateColumn,
        latest_date: latestDate,
        role: 'd1_hot_window_serving_manifest',
      }),
    }

    await upsertDatasetSnapshotManifest(env, manifest)

    written.push({ ...manifest, latest_date: latestDate })
  }

  return written
}

function isoDateOffset(date: string, days: number): string {
  const base = new Date(`${date.slice(0, 10)}T00:00:00.000Z`)
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

export async function buildDatasetRetentionPlan(
  env: Pick<Bindings, 'DB'>,
  options: {
    businessDate: string
    hotWindowDays?: number
  },
): Promise<Record<string, unknown>> {
  const hotWindowDays = Math.max(30, Math.min(Number(options.hotWindowDays ?? 252) || 252, 1600))
  const cutoffDate = isoDateOffset(options.businessDate, -hotWindowDays)
  const tables = []

  for (const spec of D1_RETENTION_TABLES) {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS cold_rows,
             MIN(${spec.dateColumn}) AS min_date,
             MAX(${spec.dateColumn}) AS max_date
        FROM ${spec.table}
       WHERE ${spec.dateColumn} IS NOT NULL
         AND ${spec.dateColumn} < ?
    `).bind(cutoffDate).first<{
      cold_rows?: number
      min_date?: string | null
      max_date?: string | null
    }>()
    tables.push({
      table: spec.table,
      kind: spec.kind,
      date_column: spec.dateColumn,
      cutoff_date: cutoffDate,
      cold_rows: Number(row?.cold_rows ?? 0),
      min_date: row?.min_date ?? null,
      max_date: row?.max_date ?? null,
      dry_run: true,
      delete_sql: `DELETE FROM ${spec.table} WHERE ${spec.dateColumn} IS NOT NULL AND ${spec.dateColumn} < ?`,
    })
  }

  return {
    dry_run: true,
    business_date: options.businessDate,
    hot_window_days: hotWindowDays,
    cutoff_date: cutoffDate,
    tables,
    total_cold_rows: tables.reduce((sum, table) => sum + Number(table.cold_rows ?? 0), 0),
    note: 'This endpoint is an audit plan only; it does not delete D1 cold rows.',
  }
}
