export type PendingBuyVisibleState =
  | 'empty'
  | 'empty_after_hard_safety'
  | 'empty_after_soft_risk'
  | 'halted'
  | 'error'
  | 'base_ready'
  | 'debate_pending'
  | 'ready_to_execute'
  | 'filled'
  | 'skipped'
  | 'expired'
  | 'closed'

export interface PendingBuyStateItem {
  symbol: string
  debate_status?: string | null
  execution_status?: string | null
}

export interface PendingBuyStateMeta {
  status?: string
  debate_status?: string
  candidate_count?: number
  error_message?: string
  empty_reason?: string
  filter_audit?: Record<string, unknown>
  execution_counts?: Record<string, number>
  debate_counts?: Record<string, number>
}

export interface PendingBuyStateSummary {
  state: PendingBuyVisibleState
  label: string
  active_count: number
  total_count: number
  execution_counts: Record<'pending' | 'filled' | 'skipped' | 'cancelled' | 'expired' | 'rejected', number>
  debate_counts: Record<'pending' | 'completed' | 'failed' | 'skipped', number>
  error_message?: string
}

function num(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function normalizeExecutionCounts(
  counts: Record<string, number> | undefined,
  activeItems: PendingBuyStateItem[],
) {
  return {
    pending: counts?.pending == null
      ? activeItems.filter((item) => (item.execution_status ?? 'pending') === 'pending').length
      : num(counts.pending),
    filled: num(counts?.filled),
    skipped: num(counts?.skipped),
    cancelled: num(counts?.cancelled),
    expired: num(counts?.expired),
    rejected: num(counts?.rejected),
  }
}

function normalizeDebateCounts(
  counts: Record<string, number> | undefined,
  activeItems: PendingBuyStateItem[],
) {
  return {
    pending: counts?.pending == null
      ? activeItems.filter((item) => (item.debate_status ?? 'pending') === 'pending').length
      : num(counts.pending),
    completed: num(counts?.completed),
    failed: num(counts?.failed),
    skipped: num(counts?.skipped),
  }
}

function terminalStateLabel(
  executionCounts: PendingBuyStateSummary['execution_counts'],
): Pick<PendingBuyStateSummary, 'state' | 'label'> {
  const { filled, skipped, cancelled, expired, rejected } = executionCounts
  if (filled > 0 && skipped + cancelled + expired + rejected === 0) return { state: 'filled', label: '已成交' }
  if (expired > 0 && filled + skipped + cancelled + rejected === 0) return { state: 'expired', label: '已過期' }
  if (filled === 0 && expired === 0 && skipped + cancelled + rejected > 0) return { state: 'skipped', label: '已跳過/已拒絕' }
  return { state: 'closed', label: '已結束' }
}

function filterAuditInitialBuySignals(meta: PendingBuyStateMeta | null | undefined): number {
  const audit = meta?.filter_audit
  if (!audit || typeof audit !== 'object') return 0
  return num((audit as Record<string, unknown>).initial_buy_signals)
}

export function buildPendingBuyStateSummary(
  activeItems: PendingBuyStateItem[],
  meta: PendingBuyStateMeta | null | undefined,
): PendingBuyStateSummary {
  const executionCounts = normalizeExecutionCounts(meta?.execution_counts, activeItems)
  const debateCounts = normalizeDebateCounts(meta?.debate_counts, activeItems)
  const terminalCount = executionCounts.filled + executionCounts.skipped + executionCounts.cancelled + executionCounts.expired + executionCounts.rejected
  const totalCount = Math.max(num(meta?.candidate_count), activeItems.length + terminalCount, filterAuditInitialBuySignals(meta))
  const runStatus = meta?.status ?? (activeItems.length > 0 ? 'ready' : 'empty')
  const debateStatus = meta?.debate_status ?? (debateCounts.pending > 0 ? 'pending' : 'completed')

  if (runStatus === 'error') {
    return {
      state: 'error',
      label: '流程失敗',
      active_count: activeItems.length,
      total_count: totalCount,
      execution_counts: executionCounts,
      debate_counts: debateCounts,
      error_message: meta?.error_message,
    }
  }
  if (runStatus === 'halted') {
    return {
      state: 'halted',
      label: '風控暫停',
      active_count: activeItems.length,
      total_count: totalCount,
      execution_counts: executionCounts,
      debate_counts: debateCounts,
      error_message: meta?.error_message,
    }
  }

  let state: PendingBuyVisibleState = 'empty'
  let label = '沒有候選'
  if (activeItems.length === 0 && terminalCount > 0) {
    const terminal = terminalStateLabel(executionCounts)
    state = terminal.state
    label = terminal.label
  } else if (activeItems.length > 0 && (debateStatus === 'pending' || debateCounts.pending > 0)) {
    state = 'debate_pending'
    label = 'Base ready / 辯論中'
  } else if (activeItems.length > 0) {
    state = 'ready_to_execute'
    label = 'Ready / 等待執行'
  } else if (meta?.empty_reason === 'empty_after_hard_safety') {
    state = 'empty_after_hard_safety'
    label = '硬性風控後無候選'
  } else if (meta?.empty_reason === 'empty_after_soft_risk') {
    state = 'empty_after_soft_risk'
    label = '軟性風險後無候選'
  } else if (totalCount > 0) {
    state = 'base_ready'
    label = 'Base ready'
  }

  return {
    state,
    label,
    active_count: activeItems.length,
    total_count: totalCount,
    execution_counts: executionCounts,
    debate_counts: debateCounts,
    error_message: meta?.error_message,
  }
}
