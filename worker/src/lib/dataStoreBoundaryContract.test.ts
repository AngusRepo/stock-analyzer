import * as fs from 'fs'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')
const adminReadRoutes = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const schema = fs.readFileSync('schema.sql', 'utf8')

assert(
  wrangler.includes('[[r2_buckets]]') && wrangler.includes('binding = "ARTIFACTS"'),
  'Worker must expose an R2 ARTIFACTS binding for UI/report artifact reads',
)

assert(
  types.includes('ARTIFACTS?: R2Bucket'),
  'Bindings must type the optional ARTIFACTS R2 bucket',
)

assert(
  schema.includes('CREATE TABLE IF NOT EXISTS dataset_snapshots') &&
    schema.includes('primary_store') &&
    schema.includes('access_tier') &&
    schema.includes('gcs_uri') &&
    schema.includes('r2_key') &&
    schema.includes('checksum'),
  'D1 schema must include dataset_snapshots manifest fields for D1/GCS/R2 ownership',
)

assert(
  fs.existsSync('src/lib/datasetSnapshots.ts'),
  'dataset snapshot policy/helper must be centralized in src/lib/datasetSnapshots.ts',
)

const datasetSnapshots = fs.readFileSync('src/lib/datasetSnapshots.ts', 'utf8')

assert(
  datasetSnapshots.includes('resolveSnapshotStoreRole') &&
    datasetSnapshots.includes('compute') &&
    datasetSnapshots.includes('report') &&
    datasetSnapshots.includes('preview'),
  'dataset snapshot helper must encode workload-specific GCS/R2 roles',
)

assert(
  datasetSnapshots.includes('validateDatasetSnapshotManifest') &&
    datasetSnapshots.includes('primary_store') &&
    datasetSnapshots.includes('access_tier'),
  'dataset snapshot helper must validate manifest ownership before API/runtime use',
)

assert(
  datasetSnapshots.includes('recordD1HotWindowDatasetManifests') &&
    datasetSnapshots.includes('price_hot_window') &&
    datasetSnapshots.includes('technical_indicator_hot_window') &&
    datasetSnapshots.includes('chip_hot_window'),
  'data update must record D1 hot-window manifests for freshness/parity checks',
)

assert(
  datasetSnapshots.includes('recordR2ReportArtifact') &&
    datasetSnapshots.includes('recordSchedulerRunReportArtifact') &&
    datasetSnapshots.includes('r2_human_readable_report') &&
    datasetSnapshots.includes("access_tier: 'report'"),
  'pipeline/report artifacts must be written to R2 as report-tier snapshots, not copied from GCS compute snapshots',
)

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert(
  updateOrchestrator.includes('recordD1HotWindowDatasetManifests') &&
    updateOrchestrator.includes('dataset manifest write failed'),
  'update finalize must write dataset manifests instead of leaving Data Quality without a source-of-truth index',
)

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
assert(
  adminControlRoutes.includes('recordSchedulerRunReportArtifact') &&
    adminControlRoutes.includes('REPORT_ARTIFACT_TASKS') &&
    adminControlRoutes.includes("body.status === 'success'"),
  'scheduler completion callback must persist R2 report artifacts tied to the same run_id/run_date',
)

assert(
  updateOrchestrator.includes('recordSchedulerRunReportArtifact') &&
    updateOrchestrator.includes("task: 'screener'"),
  'event-driven screener completion must persist an R2 report artifact because it does not enter scheduler-callback',
)

assert(
  adminReadRoutes.includes('/api/admin/datasets/snapshots') &&
    adminReadRoutes.includes('/api/datasets/snapshots') &&
    adminReadRoutes.includes('/api/admin/datasets/snapshots/:id/manifest') &&
    adminReadRoutes.includes('/api/datasets/snapshots/:id/manifest') &&
    adminReadRoutes.includes('/api/admin/datasets/snapshots/:id/preview') &&
    adminReadRoutes.includes('/api/datasets/snapshots/:id/preview') &&
    adminReadRoutes.includes('/api/admin/datasets/retention-plan'),
  'admin read routes must expose dataset manifest and preview APIs without scanning D1 history',
)

assert(
  datasetSnapshots.includes('buildDatasetRetentionPlan') &&
    datasetSnapshots.includes('dry_run') &&
    datasetSnapshots.includes('cold_rows'),
  'D1 cold-data slimming must start as a dry-run retention plan, not an unreviewed delete path',
)
