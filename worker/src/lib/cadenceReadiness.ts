import type { Bindings } from '../types'
import { getSchedulerStatus } from './schedulerStatus'
import { databaseForDataDomain } from './dataDomainRegistry'

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
    'active8-oof-monthly',
  ],
}

const OBSERVED_OPTIONAL_TASKS: Record<CadenceReadiness, string[]> = {
  weekly: [
    'weekly-optuna',
    'sector-leaders',
    'adaptive-meta-policy-replay',
    'linucb-multiplier-replay',
  ],
  monthly: [],
}

export function cadenceJobClosureProblem(job: {
  id: string; lastStatus: string; statusRunDate?: string | null; lastRunAt?: string | null;
  summary?: string; lastError?: string | null;
}, cadence: CadenceReadiness, asOfDate: string): string | null {
  if (!['success', 'skip'].includes(job.lastStatus)) return job.lastError || job.summary || 'terminal callback missing'
  const date = job.statusRunDate
  const earliest = cadence === 'monthly' ? `${asOfDate.slice(0, 7)}-01`
    : new Date(Date.parse(`${asOfDate}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
  if (!date || date < earliest || date > asOfDate) return 'current_cycle_completion_missing'
  if (!job.lastRunAt) return 'completion_timestamp_missing'
  const timestamp = Date.parse(job.lastRunAt)
  if (!Number.isFinite(timestamp)) return 'completion_timestamp_invalid'
  const observed = new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10)
  if (observed < earliest) return 'current_cycle_completion_missing'
  if (/closure=partial|source_incomplete|SKIPPED_NOT_READY/.test(job.summary ?? '')) return 'research_sources_incomplete'
  if (job.id.startsWith('active8-oof-') && /\bstatus=(?:spawned|pending|triggered|running)\b/.test(job.summary ?? '')) {
    return 'dispatch_is_not_terminal_closure'
  }
  return null
}

export async function active8CadenceReceiptProblem(db: D1Database, job: {
  id: string; summary?: string; statusRunDate?: string | null;
}): Promise<string | null> {
  // Reuse the existing callback-owned freshness ledger, not a second release
  // owner. The compute run and cohort are in the terminal callback summary.
  const runId = /\brun_id=([^\s]+)/.exec(job.summary ?? '')?.[1]
  const cohort = /\bcohort=([^\s]+)/.exec(job.summary ?? '')?.[1]
  if (!runId || !cohort || cohort === 'none' || !job.statusRunDate) return 'active8_terminal_identity_missing'
  const row = await db.prepare(`
    SELECT status, cohort_id, callback_status, expected_max_date, effective_max_date
      FROM active8_oof_freshness_sla
     WHERE task=? AND run_date=? AND run_id=?
     ORDER BY observed_at DESC, decision_key DESC LIMIT 1
  `).bind(job.id, job.statusRunDate, runId).first<{
    status: string; cohort_id: string | null; callback_status: string;
    expected_max_date: string | null; effective_max_date: string | null;
  }>()
  if (!row) return 'active8_terminal_receipt_missing'
  if (row.cohort_id !== cohort || row.status !== 'fresh' || row.callback_status !== 'success'
    || !row.expected_max_date || !row.effective_max_date || row.effective_max_date < row.expected_max_date) {
    return 'active8_terminal_receipt_not_closed'
  }
  // Validation rejection is terminal research, not permission to promote.
  // Pending full-fit is never a completed monthly/weekly release.
  if (!/\bfull_fit=(?:completed|blocked)\b/.test(job.summary ?? '')) return 'active8_full_fit_terminal_receipt_missing'
  return null
}

export async function runCadenceReadiness(
  env: Bindings,
  cadence: CadenceReadiness,
  runDate?: string,
): Promise<string> {
  const scheduler = await getSchedulerStatus(env, runDate)
  const jobs = new Map(scheduler.jobs.map((job) => [job.id, job]))
  const required = REQUIRED_TASKS[cadence]
  const asOfDate = runDate ?? new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
  const missing = required.filter((task) => !jobs.has(task))
  const blockers = required.flatMap((task) => {
    const job = jobs.get(task)
    if (!job) return []
    const problem = cadenceJobClosureProblem(job, cadence, asOfDate)
    if (!problem) return []
    return [{
      task,
      status: job.lastStatus,
      reason: problem,
    }]
  })
  const active8Task = `active8-oof-${cadence}`
  const active8Job = jobs.get(active8Task)
  if (active8Job && !blockers.some(row => row.task === active8Task)) {
    const problem = await active8CadenceReceiptProblem(databaseForDataDomain(env, 'learning'), active8Job)
    if (problem) blockers.push({ task: active8Task, status: active8Job.lastStatus, reason: problem })
  }
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
