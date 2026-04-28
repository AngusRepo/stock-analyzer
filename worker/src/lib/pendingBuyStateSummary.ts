export type PendingBuyVisibleState =
  | 'empty'
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
  execution_counts?: Record<string, number>
  debate_counts?: Record<string, number>
}

export interface PendingBuyStateSummary {
  state: PendingBuyVisibleState
  label: string
  active_count: number
  total_count: number
  execution_counts: Record<'pending' | 'filled' | 'skipped' | 'cancelled' | 'expired', number>
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
  const { filled, skipped, cancelled, expired } = executionCounts
  if (filled > 0 && skipped + cancelled + expired === 0) return { state: 'filled', label: '已成交' }
  if (expired > 0 && filled + skipped + cancelled === 0) return { state: 'expired', label: '已過期' }
  if (filled === 0 && expired === 0 && skipped + cancelled > 0) return { state: 'skipped', label: '已跳過' }
  return { state: 'closed', label: '已收斂' }
}

export function buildPendingBuyStateSummary(
  activeItems: PendingBuyStateItem[],
  meta: PendingBuyStateMeta | null | undefined,
): PendingBuyStateSummary {
  const executionCounts = normalizeExecutionCounts(meta?.execution_counts, activeItems)
  const debateCounts = normalizeDebateCounts(meta?.debate_counts, activeItems)
  const terminalCount = executionCounts.filled + executionCounts.skipped + executionCounts.cancelled + executionCounts.expired
  const totalCount = Math.max(num(meta?.candidate_count), activeItems.length + terminalCount)
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
