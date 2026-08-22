import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; schedule: string; task: string; query?: string; description?: string }>
}
const source = readFileSync('src/lib/learningTenYearRetentionReadiness.ts', 'utf8')
const routes = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const handlers = readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const capacitySource = readFileSync('src/lib/storageCapacityTelemetry.ts', 'utf8')
const adminReadSource = readFileSync('src/routes/adminReadRoutes.ts', 'utf8')

const learning = manifest.jobs.find((job) => job.id === 'learning-retention-readiness')
assert(learning)
assert.equal(learning.schedule, '20 18 * * *')
assert.equal(learning.task, 'learning-retention-readiness')
assert.match(String(learning.description), /read-only/)

const legacy = manifest.jobs.find((job) => job.id === 'legacy-learning-deletion-readiness')
assert(legacy)
assert.equal(legacy.schedule, '50 22 * * *')
assert.equal(legacy.task, 'legacy-learning-deletion-readiness')
assert.match(String(legacy.description), /no DELETE/)

const capacity = manifest.jobs.find((job) => job.id === 'storage-capacity-report')
assert(capacity)
assert.equal(capacity.schedule, '55 22 * * *')

assert.match(source, /LEARNING_HOT_RETENTION_DAYS = 730/)
assert.match(source, /LEARNING_COLD_RETENTION_DAYS = 3650/)
assert.match(source, /LEGACY_LEARNING_EARLIEST_CLEAR_DATE = '2026-09-17'/)
assert.match(source, /automatic_delete: false/)
assert.match(source, /requires_explicit_wei_approval: true/)
assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i)
assert.match(source, /tablesForDataDomainShadowBackfill\('learning'\)/)
assert.match(source, /data_domain_parity_checks/)
assert.doesNotMatch(source, /data_domain_parity_receipts/)
assert.match(source, /legacy_learning_66_table_backfill_not_complete/)
assert.match(source, /legacy_learning_66_table_parity_not_complete/)
assert.match(routes, /'learning-retention-readiness'/)
assert.match(routes, /'legacy-learning-deletion-readiness'/)
assert.match(handlers, /inspectLearningTenYearRetentionReadiness/)
assert.match(handlers, /inspectLegacyLearningDeletionReadiness/)
const learningHandler = handlers.slice(
  handlers.indexOf("'learning-retention-readiness'"),
  handlers.indexOf("'legacy-learning-deletion-readiness'"),
)
const legacyHandler = handlers.slice(
  handlers.indexOf("'legacy-learning-deletion-readiness'"),
  handlers.indexOf("'timeverse-sync'"),
)
assert.match(learningHandler, /requestedRunDate\(\) \|\| twToday\(\)/)
assert.match(legacyHandler, /requestedRunDate\(\) \|\| twToday\(\)/)
assert.match(legacyHandler, /inspectLegacyLearningDeletionReadiness\(\s*c\.env\.DB,\s*databaseForDataDomain\(c\.env, 'learning'\)/)
assert.doesNotMatch(legacyHandler, /databaseForDataDomain\(c\.env, 'ops'\)/)
assert.match(source, /inspectLegacyLearningDeletionReadiness\(\s*controlDb: D1Database/)
assert.match(source, /cutover\?\.status !== 'complete' && !domainReadiness\?\.cutover_ready/)
assert.match(source, /deletion_gate_policy: 'formal_cutover_receipt_plus_time_travel_window'/)
assert.match(source, /post_cutover_target_drift/)
assert.match(capacitySource, /meta\?\.size_after/)
assert.match(capacitySource, /utilizationPct >= 85/)
assert.match(capacitySource, /utilizationPct >= 75/)
assert.match(capacitySource, /utilizationPct >= 65/)
assert.match(handlers, /storage_capacity_daily/)
assert.match(handlers, /buildStorageCapacityGrowthEstimate/)
assert.match(capacitySource, /daily_growth_bytes/)
assert.match(capacitySource, /projected_days_to_warning_65pct/)
assert.match(capacitySource, /requiredObservations/)
assert.match(adminReadSource, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY policy_id/)
assert.match(adminReadSource, /r\.ordinal=1/)
assert.match(adminReadSource, /r\.completed_at >= datetime\('now', '-7 days'\)/)
assert.doesNotMatch(adminReadSource, /MAX\(CASE WHEN r\.status='success' THEN 1 ELSE 0 END\) AS operational/)

console.log('learning ten-year retention automation contract tests passed')
