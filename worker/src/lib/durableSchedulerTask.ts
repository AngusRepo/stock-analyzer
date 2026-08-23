import type { Bindings, UpdateQueueMsg } from '../types'
import { runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'
import { runExternalEvidenceMaterializeDetailed } from './controllerResearchWorkflows'
import { databaseForDataDomain } from './dataDomainRegistry'
import { runWithMaintenanceLease, summarizeMaintenanceLeaseResult } from './maintenanceLease'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'

type WeeklyLifecycleRunner = () => Promise<unknown>

export function requireWeeklyLifecycleDryRunSuccess(result: unknown): string {
  const summary = typeof result === 'string' ? result.trim() : ''
  if (!summary.startsWith('model_pool dry_run=')) {
    throw new Error(`weekly lifecycle dry-run failed: ${summary || 'non-success response'}`)
  }
  return summary
}

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
  const lifecycleSummary = requireWeeklyLifecycleDryRunSuccess(lifecycle)
  const maintenance = await runWeeklyLocalMaintenance(env)
  if (!cleanup.ok || !maintenance.ok) {
    throw new Error(`weekly cleanup failed ${JSON.stringify({ cleanup, maintenance })}`)
  }
  return `weekly_cleanup_v2 cleanup=${JSON.stringify(cleanup)} maintenance=${JSON.stringify(maintenance)} lifecycle dry-run=${lifecycleSummary}`
}

type DurableTaskResult = {
  summary: string
  receipt?: Record<string, unknown>
  d1Stats?: Record<string, unknown>
}

async function putTerminalReceipt(
  kv: KVNamespace,
  task: string,
  runDate: string,
  runId: string,
  result: DurableTaskResult,
): Promise<void> {
  await kv.put(
    'scheduler:terminal:' + task + ':' + runDate,
    JSON.stringify({
      schema_version: 'scheduler_terminal_receipt_v1',
      task,
      run_date: runDate,
      run_id: runId,
      status: 'success',
      summary: result.summary,
      materialization_receipt: result.receipt ?? null,
      d1_stats: result.d1Stats ?? null,
      completed_at: new Date().toISOString(),
    }),
    { expirationTtl: 30 * 86400 },
  )
}

async function runDurableTask(
  task: NonNullable<UpdateQueueMsg['scheduledTask']>,
  env: Bindings,
  runDate: string,
): Promise<DurableTaskResult> {
  if (task === 'external-evidence') {
    const result = await runExternalEvidenceMaterializeDetailed(env, runDate)
    return { summary: result.summary, receipt: result.receipt, d1Stats: result.d1Stats }
  }
  if (task === 's12-smcvwap-calibration') {
    const [{ ensureS12TwCalibrationTables, runS12TwCalibration }, { resolveS12CalibrationCadence }] = await Promise.all([
      import('./s12TwEquityCalibration'),
      import('./s12CalibrationCadence'),
    ])
    const cadence = resolveS12CalibrationCadence('auto', runDate)
    const learningDb = databaseForDataDomain(env, 'learning')
    const canonicalRunId = `s12-tw-calibration-${cadence}-${runDate}`
    const leased = await runWithMaintenanceLease(databaseForDataDomain(env, 'ops'), {
      taskName: `s12-smcvwap-calibration:${runDate}`,
      leaseGroup: `s12_smcvwap_calibration:${runDate}`,
      leaseSeconds: 7200,
      run: async (): Promise<DurableTaskResult> => {
        await ensureS12TwCalibrationTables(learningDb)
        const existing = await learningDb.prepare(`
          SELECT status, artifacts_written, summary_json
            FROM s12_tw_calibration_runs
           WHERE run_id=? AND run_date=? AND cadence=?
        `).bind(canonicalRunId, runDate, cadence).first<{
          status?: string | null
          artifacts_written?: number | string | null
          summary_json?: string | null
        }>()
        if (existing) {
          const artifactRows = await learningDb.prepare(`
            SELECT artifact_id
              FROM s12_tw_calibration_artifacts
             WHERE run_id=?
             ORDER BY artifact_id
          `).bind(canonicalRunId).all<{ artifact_id?: string | null }>()
          return {
            summary: `s12_tw_calibration idempotent run_id=${canonicalRunId} status=${existing.status ?? 'completed'} written=${Number(existing.artifacts_written ?? 0)}`,
            receipt: {
              status: existing.status ?? 'completed',
              cadence,
              written: Number(existing.artifacts_written ?? 0),
              artifact_ids: (artifactRows.results ?? []).map((row) => String(row.artifact_id ?? '')).filter(Boolean),
              idempotent: true,
              canonical_run_id: canonicalRunId,
            },
          }
        }
        const result = await runS12TwCalibration(learningDb, {
          runDate,
          cadence,
          dryRun: false,
        })
        return {
          summary: result.summary,
          receipt: {
            status: result.status,
            cadence,
            written: result.written,
            artifact_ids: result.artifacts.map((artifact) => artifact.artifactId),
            idempotent: false,
            canonical_run_id: canonicalRunId,
          },
        }
      },
    })
    if (leased && typeof leased === 'object' && 'skipped' in leased && leased.skipped === true) {
      throw new Error(leased.reason)
    }
    return leased as DurableTaskResult
  }
  return {
    summary: summarizeMaintenanceLeaseResult(await runWithMaintenanceLease(databaseForDataDomain(env, 'ops'), {
      taskName: 'weekly-cleanup',
      leaseGroup: 'd1_heavy_maintenance',
      leaseSeconds: 300,
      run: () => runWeeklyCleanupClosure(env),
    })),
  }
}

export async function processDurableSchedulerTask(msg: UpdateQueueMsg, env: Bindings): Promise<void> {
  const task = msg.scheduledTask
  if (task !== 'external-evidence' && task !== 'weekly-cleanup' && task !== 's12-smcvwap-calibration') {
    throw new Error(`unsupported durable scheduler task: ${String(task)}`)
  }
  const runDate = msg.triggerTime
  const runId = msg.runId || `${task}-${Date.now()}`
  const startedAt = Date.now()

  try {
    const taskResult = await runDurableTask(task, env, runDate)
    const status = classifySchedulerSummary(taskResult.summary)
    const result = {
      status,
      summary: taskResult.summary,
      details: taskResult.receipt
        ? ['materialization_receipt=' + JSON.stringify(taskResult.receipt)]
        : undefined,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: runDate,
    } as const
    await logSchedulerResult(env.KV, task, result, env)
    await putManualRunLog(env.KV, task, runId, { ...result, ...taskResult })
    if (status === 'success') {
      await putTerminalReceipt(env.KV, task, runDate, runId, taskResult)
    }
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
