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
  success: { className: 'bg-ok', label: '成功' },
  failed: { className: 'bg-fail', label: '失敗或超過 SLA 卡住' },
  blocked: { className: 'bg-orange-400', label: '被擋下' },
  attention: { className: 'bg-warn', label: '略過，但應該實際執行' },
  missing: { className: 'bg-amber-700', label: '沒有回執，鏈已往下走' },
  running: { className: 'bg-sky-400', label: '執行中' },
  triggered: { className: 'bg-cyan-600', label: '已觸發，等待 callback' },
  waiting: { className: 'bg-indigo-400', label: '等待中' },
  skip: { className: 'bg-slate-700', label: '略過（無動作）' },
  none: { className: 'bg-slate-900 ring-1 ring-inset ring-slate-700', label: '無回執' },
}

export function historyCellStyle(cell: SchedulerHistoryCell): { className: string; label: string } {
  return HISTORY_CELL_STYLE[cell] ?? HISTORY_CELL_STYLE.none
}
