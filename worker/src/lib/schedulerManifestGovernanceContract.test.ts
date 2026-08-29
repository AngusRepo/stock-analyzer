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

assert(schedulerManifestJobs().length === 59, 'physical Scheduler root inventory must remain 59 during governance-only phase')
assert(manifestTasks.length === 52, 'logical manifest task inventory must remain 52')
assert(summary.physicalRoots === 59, 'summary physical root count mismatch')
assert(summary.uniqueLogicalTasks === 52 && summary.accountedLogicalTasks === 52, 'logical task accounting must be 52/52')
assert(summary.reviewedDependencies === 20, 'reviewed dependency baseline must remain explicit')
assert(summary.unmappedDependencies === 32 && summary.unmappedTasks.length === 32, 'unmapped dependency debt must be explicit, not fabricated as DAG')
assert(summary.pausedPhysicalRoots === 1, 'exactly one manifest-owned physical root should be paused')
assert(summary.internalLogicalSteps === 23, 'internal logical step accounting must preserve caller total')

const paused = manifest.jobs.filter((job) => 'desiredState' in job && job.desiredState === 'PAUSED')
assert(paused.length === 1 && paused[0].id === 'data-domain-shadow-backfill-ops', 'production PAUSED truth must be represented in manifest')
for (const job of manifest.jobs) {
  const accounting = schedulerJobAccounting(job.id)
  assert(accounting.physicalRoot, `${job.id} must be classified as a physical Scheduler root`)
  assert(accounting.schedulerJobId === job.id, `${job.id} physical identity mismatch`)
  assert(accounting.task === job.task, `${job.id} logical task identity mismatch`)
  assert(accounting.ticketRequired, `${job.id} must require an execution ticket before DAG consolidation`)
}
assert(schedulerJobAccounting('post-pipeline-chain', 13).accountingClass === 'internal_chain', 'deployed chain child must be an internal logical ticket')
assert(schedulerJobAccounting('intraday-check').accountingClass === 'unmapped_dependency', 'unreviewed task must fail visible as unmapped')

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
