import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; schedule: string; task: string; query?: string; description?: string }>
}
const source = readFileSync('src/lib/learningTenYearRetentionReadiness.ts', 'utf8')
const routes = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const handlers = readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')

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
assert.match(handlers, /size_after/)
assert.match(handlers, /utilization >= 85/)
assert.match(handlers, /utilization >= 75/)
assert.match(handlers, /utilization >= 65/)
assert.match(handlers, /storage_capacity_daily/)
assert.match(handlers, /daily_growth_bytes/)
assert.match(handlers, /projected_days_to_warning_65pct/)

console.log('learning ten-year retention automation contract tests passed')
