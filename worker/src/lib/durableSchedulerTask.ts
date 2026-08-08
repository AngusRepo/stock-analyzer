import type { Bindings, UpdateQueueMsg } from '../types'
import { runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'
import { runExternalEvidenceMaterialize } from './controllerResearchWorkflows'
import { runWithMaintenanceLease, summarizeMaintenanceLeaseResult } from './maintenanceLease'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'

type WeeklyLifecycleRunner = () => Promise<unknown>

async function putManualRunLog(
  kv: KVNamespace,
  task: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await kv.put(
    `scheduler:manual:${task}:${runId}`,
    JSON.stringify({
      task,
      run_id: runId,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
    { expirationTtl: 7 * 86400 },
  )
}

export async function runWeeklyCleanupClosure(
  env: Bindings,
  lifecycleRunner?: WeeklyLifecycleRunner,
): Promise<string> {
  const cleanup = await runWeeklyCleanup(env)
  const lifecycle = lifecycleRunner
    ? await lifecycleRunner()
    : await (await import('./controllerWorkflows')).runWeeklyLifecycleCheck(env)
  const maintenance = await runWeeklyLocalMaintenance(env)
  if (!cleanup.ok || !maintenance.ok) {
    throw new Error(`weekly cleanup failed ${JSON.stringify({ cleanup, maintenance })}`)
  }
  return `weekly_cleanup_v2 cleanup=${JSON.stringify(cleanup)} maintenance=${JSON.stringify(maintenance)} lifecycle dry-run=${String(lifecycle)}`
}

async function runDurableTask(task: NonNullable<UpdateQueueMsg['scheduledTask']>, env: Bindings, runDate: string): Promise<string> {
  if (task === 'external-evidence') return runExternalEvidenceMaterialize(env, runDate)
  return summarizeMaintenanceLeaseResult(await runWithMaintenanceLease(env.DB, {
    taskName: 'weekly-cleanup',
    leaseGroup: 'd1_heavy_maintenance',
    leaseSeconds: 300,
    run: () => runWeeklyCleanupClosure(env),
  }))
}

export async function processDurableSchedulerTask(msg: UpdateQueueMsg, env: Bindings): Promise<void> {
  const task = msg.scheduledTask
  if (task !== 'external-evidence' && task !== 'weekly-cleanup') {
    throw new Error(`unsupported durable scheduler task: ${String(task)}`)
  }
  const runDate = msg.triggerTime
  const runId = msg.runId || `${task}-${Date.now()}`
  const startedAt = Date.now()

  try {
    const summary = await runDurableTask(task, env, runDate)
    const status = classifySchedulerSummary(summary)
    const result = {
      status,
      summary,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: runDate,
    } as const
    await logSchedulerResult(env.KV, task, result, env)
    await putManualRunLog(env.KV, task, runId, result)
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error)
    const result = {
      status: 'error' as const,
      summary,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: runDate,
      error: String(error),
    }
    await logSchedulerResult(env.KV, task, result, env)
    await putManualRunLog(env.KV, task, runId, result)
    throw error
  }
}
