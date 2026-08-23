import fs from 'node:fs'

const source = fs.readFileSync('src/lib/storageCapacityTelemetry.ts', 'utf8')
if (!source.includes("utilizationPct >= 85") || !source.includes("return 'critical'")) {
  throw new Error('capacity telemetry must fail before D1 reaches the hard 10GB limit')
}
if (!source.includes("utilizationPct >= 75") || !source.includes("return 'drain'")) {
  throw new Error('capacity telemetry must expose an automatic archive drain watermark')
}
if (!source.includes("utilizationPct >= 65") || !source.includes("return 'warning'")) {
  throw new Error('capacity telemetry must expose an early warning watermark')
}
if (!source.includes('meta?.size_after') || source.includes('`PRAGMA ${name}`')) {
  throw new Error('capacity telemetry must use D1 query meta.size_after, not unsupported prepared PRAGMA calls')
}
if (!source.includes("databaseForDataDomain(env, 'ops')")) {
  throw new Error('capacity observations must be persisted through the ops domain owner')
}

const taskSource = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const reportBlock = taskSource.slice(
  taskSource.indexOf("'storage-capacity-report': async () =>"),
  taskSource.indexOf("'learning-retention-readiness': async () =>"),
)
if (!reportBlock.includes('const observedDate = twToday()')) {
  throw new Error('capacity observations must always use the actual TW wall-clock date')
}
if (!reportBlock.includes('const lineageRunDate = requestedRunDate() || observedDate')) {
  throw new Error('historical scheduler lineage may be reported without backdating capacity telemetry')
}
if (!reportBlock.includes('buildStorageCapacityGrowthEstimate')) {
  throw new Error('scheduled capacity reports must use the stable post-backfill forecast estimator')
}
if (reportBlock.includes('INSERT INTO storage_capacity_daily')) {
  throw new Error('capacity reports must not duplicate or backdate the health-check telemetry writer')
}
if (!reportBlock.includes("date(observed_at, '+8 hours') = observed_date")) {
  throw new Error('capacity forecasts must reject rows whose TW observation timestamp was backdated')
}

const readRouteSource = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
if (!readRouteSource.includes("schema_version: 'storage-capacity-snapshot-v2'")) {
  throw new Error('storage capacity API must publish the D1/R2/GCS v2 contract')
}
if (!readRouteSource.includes('WITH tracked_components AS (')
  || !readRouteSource.includes("snapshot.primary_store='gcs'")
  || !readRouteSource.includes("capacity_basis: 'manifest_distinct_component_uri'")) {
  throw new Error('storage capacity API must expose deduplicated GCS component manifest telemetry')
}
if (!readRouteSource.includes("WHERE primary_store='r2'")
  || !readRouteSource.includes('Number(r2Snapshots?.tracked_bytes ?? 0)')) {
  throw new Error('storage capacity API must include R2 dataset snapshot artifacts')
}

console.log('storage capacity telemetry contract tests passed')
