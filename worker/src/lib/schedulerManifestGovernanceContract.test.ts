import * as fs from 'node:fs'
import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import {
  schedulerGovernanceSummary,
  schedulerJobAccounting,
  schedulerManifestJobs,
} from './schedulerManifestGovernance'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = schedulerManifest as typeof schedulerManifest & {
  governance: {
    schemaVersion: string
    defaults: {
      desiredState: string
      attemptDeadline: string
      retryConfig: Record<string, string | number>
    }
    parityFields: string[]
  }
}
const summary = schedulerGovernanceSummary(23)
const manifestTasks = [...new Set(manifest.jobs.map((job) => job.task))]

assert(manifest.governance.schemaVersion === 'stockvision-scheduler-governance-v1', 'manifest must declare scheduler governance v1')
assert(manifest.governance.defaults.desiredState === 'ENABLED', 'enabled must be an explicit manifest default')
assert(manifest.governance.defaults.attemptDeadline === '300s', 'attempt deadline must be manifest-owned')
for (const [field, expected] of Object.entries({
  retryCount: 0,
  maxRetryDuration: '0s',
  minBackoffDuration: '5s',
  maxBackoffDuration: '3600s',
  maxDoublings: 5,
})) {
  assert(manifest.governance.defaults.retryConfig[field] === expected, `retry default mismatch: ${field}`)
}
for (const field of ['state', 'schedule', 'timeZone', 'description', 'attemptDeadline', 'retryConfig', 'httpTarget']) {
  assert(manifest.governance.parityFields.includes(field), `manifest parity field missing: ${field}`)
}

const nativeJobs = manifest.jobs.filter(job => job.task === 'paired-native-execution')
assert(nativeJobs.length === 0, 'retired native collectors must not be scheduled')
// R33 Phase 1 (2026-10-22): the strategy NAV shadow collectors had no registered pair since 2026-09-30
// and failed every minute; both physical roots are retired. The Worker task handler stays until the
// R33 deletion slice removes the native comparison engine.
const strategyNavJobs = manifest.jobs.filter(job => job.task === 'strategy-nav-execution')
assert(strategyNavJobs.length === 0, 'retired strategy NAV collectors must not be scheduled')
assert(['paired-native-execution-day', 'paired-native-execution-morning', 'morning-briefing',
  'strategy-nav-execution-morning', 'strategy-nav-execution-day']
  .every(id => manifest.deleteJobIds.includes(id)), 'retired jobs must be explicit deletion targets')
const recoveryJobs = manifest.jobs.filter(job => job.task === 'premarket-evidence-watchdog')
assert(recoveryJobs.length === 1 && recoveryJobs[0].timeZone === 'Asia/Taipei', 'one Taipei-time recovery scheduler replaces the briefing schedule')
// 57 roots: 56 prior + daily-snapshot-settle (B#2) + postclose-research-dispatch (B#1) + the Taipei recovery job
// - the two retired strategy NAV collectors (R33 Phase 1).
assert(schedulerManifestJobs().length - recoveryJobs.length === 56, 'physical roots exclude retired strategy NAV collectors and other retired jobs')
assert(manifestTasks.filter(task => task !== 'premarket-evidence-watchdog').length === 52, 'logical inventory excludes retired strategy NAV and other retired jobs')
assert(summary.physicalRoots === 57, 'summary physical root count mismatch')
assert(summary.uniqueLogicalTasks === 53 && summary.accountedLogicalTasks === 53, 'logical task accounting must be 53/53')
assert(summary.reviewedDependencies === 35, 'reviewed dependencies include the post-close dispatcher and exclude retired jobs')
assert(summary.unmappedDependencies === 18 && summary.unmappedTasks.length === 18, 'unreviewed non-daily dependency debt must remain fail-visible')
assert(summary.pausedPhysicalRoots === 1, 'only paper shadow backfill remains paused')
assert(summary.internalLogicalSteps === 23, 'internal logical step accounting must preserve caller total')

const paused = manifest.jobs.filter((job) => 'desiredState' in job && job.desiredState === 'PAUSED')
assert(
  JSON.stringify(paused.map((job) => job.id).sort()) === JSON.stringify([
    'data-domain-shadow-backfill-paper',
  ]),
  'production PAUSED truth must be represented in manifest',
)
for (const job of manifest.jobs) {
  const accounting = schedulerJobAccounting(job.id)
  assert(accounting.physicalRoot, `${job.id} must be classified as a physical Scheduler root`)
  assert(accounting.schedulerJobId === job.id, `${job.id} physical identity mismatch`)
  assert(accounting.task === job.task, `${job.id} logical task identity mismatch`)
  assert(accounting.ticketRequired, `${job.id} must require an execution ticket before DAG consolidation`)
}
assert(schedulerJobAccounting('post-pipeline-chain', 13).accountingClass === 'internal_chain', 'deployed chain child must be an internal logical ticket')
assert(schedulerJobAccounting('intraday-check').accountingClass === 'unmapped_dependency', 'unreviewed task must fail visible as unmapped')
for (const task of [
  'us-leading', 'news-analyst', 'morning-setup', 'daily-snapshot',
  'daily-execution-paper-lineage', 'external-evidence', 'debate-memory-retention', 'artifact-reconcile',
  'retention-archive-only', 'retention-hot-window-drain', 'data-domain-shadow-backfill-next',
  'legacy-strategy-evidence-migration', 'legacy-hot-data-retirement', 'r2-retention-sweep',
  'orphan-reachability-gc', 'storage-health-check', 'learning-retention-readiness',
  'legacy-learning-deletion-readiness', 'storage-capacity-report', 'optuna-queue',
]) {
  assert(schedulerJobAccounting(task).accountingClass !== 'unmapped_dependency', `${task} must have a reviewed Daily Operations dependency contract`)
}

const rotation = fs.readFileSync('../scripts/auth_rotation_scheduler_rest.ps1', 'utf8')
for (const required of [
  'rotation_scheduler_state_mismatch',
  'rotation_scheduler_retry_config_mismatch',
  'ConvertTo-SchedulerNormalizedRetryConfig',
  'ConvertTo-SchedulerApiBody',
  'Invoke-SchedulerDesiredState',
  'scheduler_rollback_state',
]) {
  assert(rotation.includes(required), `scheduler REST governance missing: ${required}`)
}
assert(rotation.includes("@('retryCount', 'maxRetryDuration', 'minBackoffDuration', 'maxBackoffDuration', 'maxDoublings')"), 'parity must compare all semantic retry fields')

const dryRunSync = fs.readFileSync('../scripts/sync_gcp_scheduler.ps1', 'utf8')
assert(dryRunSync.includes('$governanceDefaults.attemptDeadline'), 'dry-run sync must use manifest attempt deadline')
assert(dryRunSync.includes('$retryDefaults.retryCount'), 'dry-run sync must use manifest retry defaults')
assert(dryRunSync.includes('state=$desiredState'), 'dry-run output must expose desired state')

console.log('schedulerManifestGovernanceContract.test.ts: all assertions passed')
