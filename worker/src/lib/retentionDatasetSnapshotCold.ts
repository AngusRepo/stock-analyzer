import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { validateDatasetSnapshotManifest, type DatasetSnapshotManifest, type SnapshotListFilters } from './datasetSnapshots'
import { archivedLearningRows, findArchivedLearningRow, type LearningColdEnv } from './retentionLearningColdReader'

// D1-M3: dataset_snapshots manifest rows released by the learning_lineage_v1 drain are served from
// their verified R2 cold archive. Every response built here carries `cold_archive: true`.
// Cold-read failures surface as DATASET_SNAPSHOT_COLD_READ_ERROR (503), never as "not found".

export const DATASET_SNAPSHOT_COLD_READ_ERROR = 'dataset_snapshot_cold_read_unavailable'
type ColdManifest = DatasetSnapshotManifest & { manifest_errors: string[]; cold_archive: true }
const DATE = /^\d{4}-\d{2}-\d{2}$/

function coldManifest(row: Record<string, unknown>): ColdManifest {
  const manifest = row as unknown as DatasetSnapshotManifest
  return { ...manifest, manifest_errors: validateDatasetSnapshotManifest(manifest), cold_archive: true }
}

/** Ids are `<kind>:<business_date>:<run>`; without a date the cold range is unknown and the id is not served. */
export async function coldDatasetSnapshotManifest(env: LearningColdEnv, snapshotId: string): Promise<ColdManifest | null> {
  const date = /^[^:]+:(\d{4}-\d{2}-\d{2}):/.exec(snapshotId)?.[1]
  if (!date) return null
  const row = await findArchivedLearningRow(env, databaseForDataDomain(env as Bindings, 'learning'),
    'dataset_snapshots', 'snapshot_id', snapshotId, { startDate: date, endDate: date })
  return row ? coldManifest(row) : null
}

/** Same response shape as readDatasetSnapshotPreview, for a manifest that lives only in the cold archive. */
export async function coldDatasetSnapshotPreview(env: LearningColdEnv, snapshotId: string,
  byteLimit = 128 * 1024): Promise<Record<string, unknown> | null> {
  const manifest = await coldDatasetSnapshotManifest(env, snapshotId)
  if (!manifest) return null
  if (!manifest.r2_key) return { found: true, cold_archive: true, available: false, manifest, reason: 'r2_key_missing' }
  if (!env.ARTIFACTS) return { found: true, cold_archive: true, available: false, manifest, reason: 'r2_binding_missing' }
  const object = await (env.ARTIFACTS as any).get(manifest.r2_key, {
    range: { offset: 0, length: Math.max(1, Math.min(byteLimit, 512 * 1024)) },
  })
  if (!object) return { found: true, cold_archive: true, available: false, manifest, reason: 'r2_object_not_found' }
  const text = await object.text()
  return {
    found: true,
    cold_archive: true,
    available: true,
    manifest,
    preview: text,
    truncated: Boolean(object.size && object.size > text.length),
    bytes_read: text.length,
    content_type: object.httpMetadata?.contentType ?? null,
  }
}

/**
 * Hot list rows plus released cold rows of one business date. The cold range is only bounded when a
 * `date` filter is given; without it the list stays hot-only and says so instead of silently omitting.
 */
export async function withColdDatasetSnapshots<T extends Record<string, unknown>>(env: LearningColdEnv,
  filters: SnapshotListFilters, hotRows: T[]): Promise<{
    snapshots: Array<T | ColdManifest>
    cold_archive: { included: boolean; rows: number; reason?: string }
  }> {
  const date = filters.businessDate
  if (!date || !DATE.test(date))
    return { snapshots: hotRows, cold_archive: { included: false, rows: 0, reason: 'date_filter_required' } }
  // Only run-report (report tier) and D1 hot-window (serving tier) manifests ever drain
  // (DATASET_SNAPSHOT_ELIGIBILITY); other filters cannot match a cold row, so skip the archive read.
  const drainable = (!filters.accessTier || filters.accessTier === 'report' || filters.accessTier === 'serving')
    && (!filters.kind || /_(run_report|hot_window)$/.test(filters.kind))
  if (!drainable) return { snapshots: hotRows, cold_archive: { included: false, rows: 0, reason: 'filter_never_drains' } }
  const cold: ColdManifest[] = []
  const rowFilter = (row: Record<string, unknown>) => (!filters.kind || row.kind === filters.kind)
    && (!filters.accessTier || row.access_tier === filters.accessTier)
  for await (const chunk of archivedLearningRows(env, databaseForDataDomain(env as Bindings, 'learning'), 'dataset_snapshots',
    { startDate: date, endDate: date, rowFilter })) cold.push(...chunk.map(item => coldManifest(item.row)))
  const limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Math.min(Math.trunc(Number(filters.limit)), 200)) : 50
  const snapshots = [...hotRows, ...cold].sort((a, b) => String(b.business_date).localeCompare(String(a.business_date))
    || String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))).slice(0, limit)
  return { snapshots, cold_archive: { included: true, rows: cold.length } }
}
