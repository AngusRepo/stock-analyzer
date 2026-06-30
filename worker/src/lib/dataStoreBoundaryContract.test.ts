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
    datasetSnapshots.includes('chip_hot_window') &&
    datasetSnapshots.includes('margin_hot_window'),
  'data update must record D1 hot-window manifests for freshness/parity checks, including margin/short data',
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
  adminReadRoutes.includes('D1_HOT_WINDOW_DAYS') &&
    adminReadRoutes.includes("c.req.query('hot_window_days')") &&
    adminReadRoutes.includes("c.req.query('hotWindowDays')"),
  'retention-plan route must default to the approved D1 hot window and accept both snake/camel query names',
)

assert(
  datasetSnapshots.includes('buildDatasetRetentionPlan') &&
    datasetSnapshots.includes('dry_run') &&
    datasetSnapshots.includes('cold_rows'),
  'D1 cold-data slimming must start as a dry-run retention plan, not an unreviewed delete path',
)

assert(
  datasetSnapshots.includes('D1_HOT_WINDOW_DAYS = 504') &&
    datasetSnapshots.includes('D1_COLD_ARCHIVE_KIND') &&
    datasetSnapshots.includes('findColdArchiveCoverage') &&
    datasetSnapshots.includes('safe_to_delete') &&
    datasetSnapshots.includes('delete_blocker'),
  'D1 retention must use the approved 504-day hot window and require GCS archive coverage before deletion is allowed',
)

assert(
  fs.existsSync('src/lib/auditJsonArchive.ts'),
  'large D1 audit JSON retention must be centralized in src/lib/auditJsonArchive.ts',
)

const auditJsonArchive = fs.readFileSync('src/lib/auditJsonArchive.ts', 'utf8')

assert(
  auditJsonArchive.includes("AUDIT_JSON_ARCHIVE_KIND = 'd1_audit_json_archive'") &&
    auditJsonArchive.includes('ARCHIVE_D1_AUDIT_JSON_TO_R2') &&
    auditJsonArchive.includes('strategy_decision_log') &&
    auditJsonArchive.includes('screener_funnel_items') &&
    auditJsonArchive.includes('paper_execution_events'),
  'audit JSON archive must cover strategy decisions, screener funnel items, and paper execution events behind an explicit confirm phrase',
)

assert(
  auditJsonArchive.includes("primary_store: 'r2'") &&
    auditJsonArchive.includes("access_tier: 'archive'") &&
    auditJsonArchive.includes('scrub_json_columns_to_r2_pointer') &&
    auditJsonArchive.includes('archived_to_r2: true'),
  'audit JSON archive must write full payloads to R2 archive manifests before replacing D1 JSON blobs with pointers',
)

assert(
  datasetSnapshots.includes('isR2AuditJsonArchive') &&
    datasetSnapshots.includes("startsWith('d1_audit_json_archive')") &&
    datasetSnapshots.includes('allowR2AuditArchive'),
  'dataset snapshot validation must allow only the audit JSON archive kind to use R2 as archive-tier primary store',
)

assert(
  adminReadRoutes.includes('/api/admin/datasets/audit-json-retention-plan') &&
    adminReadRoutes.includes('buildAuditJsonRetentionPlan'),
  'admin read routes must expose a dry-run plan for D1 audit JSON retention',
)
