/// <reference path="../cf-types.d.ts" />

import {
  normalizeComputeProfileEvent,
  normalizeComputeEfficiencyReportEvent,
  recordWorkerTaskComputeProfile,
  recordSchedulerCallbackComputeProfile,
  recordComputeProfileEvent,
  recordComputeEfficiencyReportEvent,
} from './computeProfileEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function createMockEnv(options: { failFirstRun?: Error } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let runCount = 0
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                runCount += 1
                if (runCount === 1 && options.failFirstRun) throw options.failFirstRun
                calls.push({ sql, params })
                return { success: true }
              },
            }
          },
        }
      },
    },
  }
  return { env, calls }
}

{
  const event = normalizeComputeProfileEvent({
    eventDate: '2026-05-17',
    provider: 'modal',
    jobName: 'monthly-universal-retrain',
    runId: 'modal-run-1',
    profile: {
      wall_sec: 3300,
      compute_sec: 6600,
      await_sec: 0,
      compute_owner: 'modal',
      remote_function: 'predict_batch_v2',
      cpu: 2,
      memory_mb: 8192,
      gpu: 'L4',
      est_usd: 4.6,
      rows: 1_200_000,
      features: 106,
      symbols: 2200,
      trials: 80,
      cache_hit_ratio: 0.78,
    },
  })

  assert(event.provider === 'modal', 'provider should be preserved')
  assert(event.jobName === 'monthly-universal-retrain', 'job name should be preserved')
  assert(event.wallSec === 3300, 'wall seconds should normalize')
  assert(event.computeSec === 6600, 'compute seconds should normalize')
  assert(event.awaitSec === 0, 'await seconds should normalize')
  assert(event.computeOwner === 'modal', 'compute owner should normalize')
  assert(event.remoteFunction === 'predict_batch_v2', 'remote function should normalize')
  assert(event.memoryMb === 8192, 'memory should normalize')
  assert(event.cacheHitRatio === 0.78, 'cache hit ratio should normalize')
  assert(event.profileJson.includes('"features":106'), 'raw profile should be JSON encoded')
}

{
  const reportEvent = normalizeComputeEfficiencyReportEvent({
    schema_version: 'compute-efficiency-contract-v1',
    generated_at: '2026-05-17T00:00:00Z',
    job_name: 'weekly-validation-bundle',
    decision: 'ACCEPT_HIGH_SPEC_EFFICIENCY',
    baseline: { wall_sec: 1000, est_usd: 1.0, features: 106 },
    optimized: { wall_sec: 700, est_usd: 0.7, features: 106 },
    quality: { ic_delta: 0.001, topk_overlap: 0.82 },
    efficiency: { wall_time_reduction_pct: 30, estimated_cost_reduction_pct: 30 },
  })

  assert(reportEvent.reportDate === '2026-05-17', 'report date should derive from generated_at')
  assert(reportEvent.jobName === 'weekly-validation-bundle', 'job should be preserved')
  assert(reportEvent.decision === 'ACCEPT_HIGH_SPEC_EFFICIENCY', 'decision should be preserved')
  assert(reportEvent.reportJson.includes('compute-efficiency-contract-v1'), 'full report should be JSON encoded')
}

async function runPersistenceChecks() {
  const { env, calls } = createMockEnv()
  await recordComputeProfileEvent(env as any, {
    eventDate: '2026-05-17',
    provider: 'gcp_cloud_run',
    jobName: 'pipeline-v2',
    profile: {
      wall_sec: 600,
      compute_sec: 2400,
      await_sec: 120,
      compute_owner: 'gcp_cloud_run_orchestrator',
      remote_function: 'modal.predict_batch_v2',
      cpu: 4,
      memory_mb: 4096,
      features: 106,
    },
  })
  await recordComputeEfficiencyReportEvent(env as any, {
    generated_at: '2026-05-17T00:00:00Z',
    job_name: 'pipeline-v2',
    decision: 'KEEP_BASELINE_RUNTIME',
    baseline: { wall_sec: 600, est_usd: 0.8, features: 106 },
    optimized: { wall_sec: 610, est_usd: 0.82, features: 106 },
    quality: { ic_delta: 0.0 },
    efficiency: { wall_time_reduction_pct: -1.67 },
  })

  assert(calls.length === 2, 'two D1 writes should be issued')
  assert(calls[0].sql.includes('compute_profile_events'), 'profile write should target profile events table')
  assert(calls[0].sql.includes('await_sec'), 'profile write should persist await seconds')
  assert(calls[0].sql.includes('compute_owner'), 'profile write should persist compute owner')
  assert(calls[0].sql.includes('remote_function'), 'profile write should persist remote function')
  assert(calls[0].params[6] === 120, 'await seconds should be inserted')
  assert(calls[0].params[7] === 'gcp_cloud_run_orchestrator', 'compute owner should be inserted')
  assert(calls[0].params[8] === 'modal.predict_batch_v2', 'remote function should be inserted')
  assert(calls[1].sql.includes('compute_efficiency_reports'), 'report write should target efficiency reports table')
}

void runPersistenceChecks()

async function runLegacyProfileColumnFallbackCheck() {
  const { env, calls } = createMockEnv({ failFirstRun: new Error('table compute_profile_events has no column named await_sec') })
  await recordComputeProfileEvent(env as any, {
    eventDate: '2026-05-17',
    provider: 'gcp_cloud_run',
    jobName: 'pipeline-v2',
    profile: {
      wall_sec: 600,
      compute_sec: 2400,
      await_sec: 120,
      compute_owner: 'gcp_cloud_run_orchestrator',
      remote_function: 'modal.predict_batch_v2',
    },
  })

  assert(calls.length === 1, 'legacy-column fallback should retry one insert')
  assert(!calls[0].sql.includes('await_sec'), 'fallback insert should preserve legacy table compatibility')
  assert(calls[0].params[0] === '2026-05-17', 'fallback should preserve event date')
  assert(String(calls[0].params[calls[0].params.length - 1]).includes('"await_sec":120'), 'fallback should preserve wait fields inside profile JSON')
}

void runLegacyProfileColumnFallbackCheck()

async function runSchedulerCallbackProfileCheck() {
  const { env, calls } = createMockEnv()
  await recordSchedulerCallbackComputeProfile(env as any, {
    task: 'pipeline',
    status: 'success',
    durationMs: 840_000,
    runDate: '2026-05-25',
    runId: 'pipeline-v2-run-1',
    metadata: {
      provider: 'gcp_cloud_run',
      job_name: 'pipeline-v2',
      compute_owner: 'gcp_cloud_run_orchestrator',
      remote_function: 'pipeline_job_main',
      cpu: 4,
      memory_mb: 4096,
      duration_ms_semantics: 'pipeline_graph_runtime_excludes_callback_tail',
    },
  })

  assert(calls.length === 1, 'scheduler callback profile should issue one D1 write')
  assert(calls[0].params[0] === '2026-05-25', 'callback profile should use callback run date')
  assert(calls[0].params[1] === 'gcp_cloud_run', 'callback profile should preserve provider')
  assert(calls[0].params[2] === 'pipeline-v2', 'callback profile should use callback job name')
  assert(calls[0].params[3] === 'pipeline-v2-run-1', 'callback profile should preserve run id')
  assert(calls[0].params[4] === 840, 'callback duration should convert ms to wall seconds')
  assert(calls[0].params[5] === 3360, 'callback compute seconds should use Cloud Run cpu metadata')
  assert(calls[0].params[7] === 'gcp_cloud_run_orchestrator', 'callback profile should preserve compute owner')
  assert(calls[0].params[8] === 'pipeline_job_main', 'callback profile should preserve remote function')
  assert(calls[0].params[9] === 4, 'callback profile should persist cpu')
  assert(calls[0].params[10] === 4096, 'callback profile should persist memory')
  assert(String(calls[0].params[calls[0].params.length - 1]).includes('pipeline_graph_runtime_excludes_callback_tail'), 'callback profile JSON should preserve duration semantics')
}

void runSchedulerCallbackProfileCheck()

async function runSchedulerCallbackTriggeredSkipCheck() {
  const { env, calls } = createMockEnv()
  await recordSchedulerCallbackComputeProfile(env as any, {
    task: 'dataset-snapshot-export',
    status: 'triggered',
    durationMs: 200,
    runDate: '2026-05-25',
    runId: 'pipeline-v2-run-1:snapshot',
    metadata: { provider: 'modal', remote_function: 'dataset_snapshot_export' },
  })

  assert(calls.length === 0, 'trigger-only callbacks should not create misleading compute profile rows')
}

void runSchedulerCallbackTriggeredSkipCheck()

async function runWorkerTaskProfileCheck() {
  const { env, calls } = createMockEnv()
  await recordWorkerTaskComputeProfile(env as any, {
    task: 'paper-active-postmarket',
    status: 'success',
    durationMs: 1234,
    runDate: '2026-05-17',
    runId: 'chain-1',
    chain: 'post_verify_chain',
  })

  assert(calls.length === 1, 'worker task profile should issue one D1 write')
  assert(calls[0].sql.includes('compute_profile_events'), 'worker task profile should target compute profile events')
  assert(calls[0].params[0] === '2026-05-17', 'event date should use run date')
  assert(calls[0].params[1] === 'cloudflare_worker', 'provider should be cloudflare worker')
  assert(calls[0].params[2] === 'paper-active-postmarket', 'job name should use scheduler task')
  assert(calls[0].params[4] === 1.234, 'duration should convert ms to wall seconds')
  assert(calls[0].params[5] === 1.234, 'successful worker task should count as compute seconds')
}

void runWorkerTaskProfileCheck()

async function runWorkerDispatchOnlyProfileCheck() {
  const { env, calls } = createMockEnv()
  await recordWorkerTaskComputeProfile(env as any, {
    task: 'verify-v2',
    status: 'triggered',
    durationMs: 1918,
    runDate: '2026-05-22',
    runId: 'pipeline-v2-44n7x',
    chain: 'post_market_callback',
  })

  assert(calls.length === 1, 'dispatch-only worker task profile should still issue one D1 write')
  assert(calls[0].params[2] === 'verify-v2', 'dispatch-only profile should keep task name')
  assert(calls[0].params[4] === 1.918, 'dispatch-only wall seconds should be preserved')
  assert(calls[0].params[5] === 0, 'dispatch-only task should not count as compute seconds')
  assert(calls[0].params[6] === 1.918, 'dispatch-only task should count as await seconds')
  assert(calls[0].params[7] === 'orchestration_dispatch', 'dispatch-only task should expose wait owner')
}

void runWorkerDispatchOnlyProfileCheck()
