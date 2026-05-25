import type { Bindings } from '../types'
import { recordSchedulerRunReportArtifact } from './datasetSnapshots'
import { closeOptunaRunD1Lock, optunaRunDateFromRunId } from './optunaQueue'

type OptunaClosureStatus = 'success' | 'error' | 'skipped' | 'triggered' | 'running'

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

export function resolveOptunaCallbackRunDate(input: {
  runDate?: string
  runId?: string
}): string {
  return input.runDate || optunaRunDateFromRunId(input.runId) || twToday()
}

export async function closeOptunaQueueCallbackRun(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  input: {
    status: OptunaClosureStatus
    runId?: string
    runDate?: string
    summary?: string
    durationMs?: number
    error?: string
    metadata?: Record<string, unknown>
  },
): Promise<{
  closed: boolean
  lock_key?: string
  artifact_written: boolean
  business_date: string
}> {
  const businessDate = resolveOptunaCallbackRunDate({
    runDate: input.runDate,
    runId: input.runId,
  })
  const terminal = input.status === 'success' || input.status === 'error' || input.status === 'skipped'
  if (!terminal || !input.runId) {
    return {
      closed: false,
      artifact_written: false,
      business_date: businessDate,
    }
  }

  const lock = await closeOptunaRunD1Lock(env.DB, input.runId, input.status)
  const artifact = await recordSchedulerRunReportArtifact(env, {
    task: 'optuna-queue',
    status: input.status,
    businessDate,
    runId: input.runId,
    summary: input.summary ?? '',
    durationMs: input.durationMs ?? 0,
    error: input.error,
    metadata: {
      closure: 'optuna_per_regime_callback',
      d1_run_lock_closed: lock.closed,
      d1_run_lock_key: lock.lock_key,
      ...(input.metadata ?? {}),
    },
  })

  return {
    closed: lock.closed,
    lock_key: lock.lock_key,
    artifact_written: Boolean(artifact),
    business_date: businessDate,
  }
}
