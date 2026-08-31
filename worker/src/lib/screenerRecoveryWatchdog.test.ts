import assert from 'node:assert/strict'
import fs from 'node:fs'
import { screenerLeaseExpired, screenerRetryDecision } from './screenerRecoveryWatchdog'
import { pipelineProvenanceRecoveryDecision } from './postScreenerContinuation'

const future = '2026-08-14 14:00:00'
const past = '2026-08-14 12:00:00'
const now = Date.parse('2026-08-14T13:00:00Z')

assert.equal(screenerLeaseExpired({ status: 'running', lease_expires_at: future }, now), false)
assert.equal(screenerLeaseExpired({ status: 'running', lease_expires_at: past }, now), true)
assert.deepEqual(
  screenerRetryDecision({ status: 'running', attempt_count: 1, lease_expires_at: future } as any, now),
  { retry: false, reason: 'active_lease' },
)
assert.deepEqual(
  screenerRetryDecision({ status: 'running', attempt_count: 1, lease_expires_at: past } as any, now),
  { retry: true, reason: 'lease_expired' },
)
assert.deepEqual(
  screenerRetryDecision({ status: 'error', attempt_count: 3, lease_expires_at: null } as any, now),
  { retry: false, reason: 'retry_exhausted' },
)
assert.deepEqual(screenerRetryDecision(null, now), { retry: true, reason: 'stage_missing' })

const provenanceFailure = {
  canonical_run_id: 'pipeline-dispatch:2026-08-28:failed',
  status: 'error',
  last_error: 'ValueError: pipeline_modal_source_sha_mismatch',
  updated_at: '2026-08-28 13:48:34',
}
const oldWorkerVersion = {
  id: 'old-release',
  tag: 'a'.repeat(40),
  timestamp: '2026-08-28T13:40:00.000Z',
}
const repairedWorkerVersion = {
  id: 'new-release',
  tag: 'b'.repeat(40),
  timestamp: '2026-08-28T15:38:10.000Z',
}
assert.deepEqual(
  pipelineProvenanceRecoveryDecision({ failure: provenanceFailure, workerVersion: oldWorkerVersion }),
  { retry: false, reason: 'worker_release_not_newer_than_failure' },
)
assert.deepEqual(
  pipelineProvenanceRecoveryDecision({ failure: provenanceFailure, workerVersion: repairedWorkerVersion }),
  { retry: true, reason: 'new_worker_release_after_provenance_failure' },
)
assert.deepEqual(
  pipelineProvenanceRecoveryDecision({
    failure: { ...provenanceFailure, last_error: 'ValueError: feature_contract_mismatch' },
    workerVersion: repairedWorkerVersion,
  }),
  { retry: false, reason: 'pipeline_error_not_provenance_mismatch' },
)

const root = process.cwd()
const orchestrator = fs.readFileSync(`${root}/src/lib/updateOrchestrator.ts`, 'utf8')
const callback = fs.readFileSync(`${root}/src/routes/adminControlRoutes.ts`, 'utf8')
const tasks = fs.readFileSync(`${root}/src/lib/adminTriggerWorkerDomainTasks.ts`, 'utf8')
const scheduler = fs.readFileSync(`${root}/../infra/gcp-scheduler-jobs.json`, 'utf8')
const watchdog = fs.readFileSync(`${root}/src/lib/screenerRecoveryWatchdog.ts`, 'utf8')
const continuation = fs.readFileSync(`${root}/src/lib/postScreenerContinuation.ts`, 'utf8')
const paperEntryTasks = fs.readFileSync(`${root}/src/lib/paperEntryTasks.ts`, 'utf8')

assert(orchestrator.includes('triggerCanonicalScreenerStage'))
assert(orchestrator.includes('canonicalRunId: runId'))
assert(callback.includes('recordCanonicalScreenerCallback'))
assert(callback.includes('screenerCallbackLineageAccepted'))
assert(watchdog.includes("stage='screener_v2'"))
assert(watchdog.includes("authorityStage: 'screener_v2'"))
assert(callback.indexOf("body.task === 'screener'") < callback.indexOf('const logAcceptedCallbackTask'))
assert(watchdog.includes('const SCREENER_LEASE_SECONDS = 6000'))
assert(watchdog.includes('AND run_id=?'))
assert(watchdog.includes('cursor_key=?'))
assert(watchdog.includes('screener_callback_stale_non_success_after_success'))
assert(continuation.includes("POST_SCREENER_CONTINUATION_STAGE = 'post_screener_continuation'"))
assert(continuation.includes("enqueuePipelineStage(databaseForDataDomain(env, 'ops')"))
assert(continuation.includes("pipeline.stage='pipeline_execution'"))
assert(continuation.includes("pipeline.last_error=?"))
assert(continuation.includes("pipeline.updated_at=?"))
assert(continuation.includes("release_recovery_already_claimed"))
assert(watchdog.includes('enqueuePostScreenerPipelineRecovery'))
assert(!scheduler.includes('pipeline-execution-watchdog'))
assert(!watchdog.includes('env.DB'))
assert(callback.includes("recordCanonicalScreenerCallback(databaseForDataDomain(c.env, 'ops')"))
assert(paperEntryTasks.includes("const opsDb = databaseForDataDomain(env, 'ops')"))
assert(!paperEntryTasks.includes('acquireIntradayExecutionLease(env.DB'))
assert(!paperEntryTasks.includes('refreshIntradayExecutionLease(env.DB'))
assert(continuation.includes('supersedePrevious: true'))
assert(callback.includes("scheduler:run:screener-v2-watchdog:${callbackRunDate}"))
assert(callback.includes('Screener watchdog terminal callback accepted'))
assert(callback.includes("logSchedulerResult(c.env.KV, 'screener-v2-watchdog'"))
assert(!paperEntryTasks.includes('releaseIntradayExecutionLease(env.DB'))
assert(tasks.includes("'screener-v2-watchdog'"))
assert(scheduler.includes('"id": "screener-v2-watchdog"'))
assert(scheduler.includes('max 3 attempts'))

console.log('screener recovery watchdog tests passed')
