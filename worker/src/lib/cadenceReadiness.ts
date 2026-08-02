import type { Bindings } from '../types'
import { getSchedulerStatus } from './schedulerStatus'

export type CadenceReadiness = 'weekly' | 'monthly'

const REQUIRED_TASKS: Record<CadenceReadiness, string[]> = {
  weekly: [
    'weekly-audit',
    'model-ic-full-check',
    'storage-integrity-audit',
    'weekly-cleanup',
    'weekly-backtest',
    'alpha-quality',
    's12-smcvwap-calibration',
    'active8-oof-weekly',
  ],
  monthly: [
    'storage-capacity-report',
    'monthly-strategy-mining',
    'monthly-optuna',
    'monthly-retrain',
    'active8-oof-monthly',
  ],
}

const OBSERVED_OPTIONAL_TASKS: Record<CadenceReadiness, string[]> = {
  weekly: [
    'weekly-optuna',
    'sector-leaders',
    'adaptive-meta-policy-replay',
    'linucb-multiplier-replay',
    'weekly-drift-retrain',
  ],
  monthly: [],
}

function terminal(status: string): boolean {
  return status === 'success' || status === 'skip'
}

export async function runCadenceReadiness(
  env: Bindings,
  cadence: CadenceReadiness,
): Promise<string> {
  const scheduler = await getSchedulerStatus(env)
  const jobs = new Map(scheduler.jobs.map((job) => [job.id, job]))
  const required = REQUIRED_TASKS[cadence]
  const missing = required.filter((task) => !jobs.has(task))
  const blockers = required.flatMap((task) => {
    const job = jobs.get(task)
    if (!job || terminal(job.lastStatus)) return []
    return [{
      task,
      status: job.lastStatus,
      reason: job.lastError || job.summary || 'terminal callback missing',
    }]
  })
  const optional = OBSERVED_OPTIONAL_TASKS[cadence].map((task) => {
    const job = jobs.get(task)
    return {
      task,
      status: job?.lastStatus ?? 'missing',
    }
  })

  if (missing.length > 0 || blockers.length > 0) {
    throw new Error(cadence + '_readiness_blocked ' + JSON.stringify({
      missing,
      blockers,
      optional,
    }))
  }

  return cadence + '_readiness_closed required=' + required.length + '/' + required.length + ' optional=' + JSON.stringify(optional)
}
