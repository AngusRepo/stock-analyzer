import {
  normalizeComputeProfileEvent,
  normalizeComputeEfficiencyReportEvent,
  recordWorkerTaskComputeProfile,
  recordComputeProfileEvent,
  recordComputeEfficiencyReportEvent,
} from './computeProfileEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function createMockEnv() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
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
    profile: { wall_sec: 600, compute_sec: 2400, cpu: 4, memory_mb: 4096, features: 106 },
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
  assert(calls[1].sql.includes('compute_efficiency_reports'), 'report write should target efficiency reports table')
}

void runPersistenceChecks()

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
}

void runWorkerTaskProfileCheck()
