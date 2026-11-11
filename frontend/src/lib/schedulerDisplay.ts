import type { SchedulerHistoryCell, SchedulerJob } from './api'

/** `Historical replay · M/D` when the row's status belongs to an older run_date. */
export function historicalReplayLabel(job?: Pick<SchedulerJob, 'statusScope' | 'statusRunDate'>): string | null {
  if (job?.statusScope !== 'historical_replay' || !job.statusRunDate) return null
  const parts = /^\d{4}-(\d{2})-(\d{2})$/.exec(job.statusRunDate)
  return `Historical replay · ${parts ? `${Number(parts[1])}/${Number(parts[2])}` : job.statusRunDate}`
}

/** A skip that should have run for real; never a neutral no-op. */
export function attentionSkipReason(job?: Pick<SchedulerJob, 'lastStatus' | 'attentionReason'>): string | null {
  return job?.lastStatus === 'skip' ? job.attentionReason ?? null : null
}

const HISTORY_CELL_STYLE: Record<SchedulerHistoryCell, { className: string; label: string }> = {
  success: { className: 'bg-emerald-400', label: 'success' },
  failed: { className: 'bg-rose-400', label: 'failed or stuck past SLA' },
  blocked: { className: 'bg-orange-400', label: 'blocked' },
  attention: { className: 'bg-amber-400', label: 'skipped; should have run for real' },
  missing: { className: 'bg-amber-700', label: 'no receipt; chain moved on without it' },
  running: { className: 'bg-sky-400', label: 'running' },
  triggered: { className: 'bg-cyan-600', label: 'triggered; awaiting callback' },
  waiting: { className: 'bg-indigo-400', label: 'waiting' },
  skip: { className: 'bg-slate-700', label: 'skipped (no-op)' },
  none: { className: 'bg-slate-900 ring-1 ring-inset ring-slate-700', label: 'no receipt' },
}

export function historyCellStyle(cell: SchedulerHistoryCell): { className: string; label: string } {
  return HISTORY_CELL_STYLE[cell] ?? HISTORY_CELL_STYLE.none
}
