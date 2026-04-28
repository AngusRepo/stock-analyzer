export type PendingBuyExecutionStatus = 'pending' | 'filled' | 'skipped' | 'cancelled' | 'expired'
export type PendingBuyTerminalExecutionStatus = Exclude<PendingBuyExecutionStatus, 'pending'>

export interface PendingBuyExecutionItem {
  symbol: string
  execution_status?: PendingBuyExecutionStatus | null
  watch_points?: string[]
}

export interface PendingBuyExecutionEvent {
  symbol: string
  status: PendingBuyTerminalExecutionStatus
  reason: string
}

export interface PendingBuyExecutionTransition {
  allItems: PendingBuyExecutionItem[]
  activeItems: PendingBuyExecutionItem[]
  summary: Record<PendingBuyTerminalExecutionStatus, number>
  changed: boolean
}

const TERMINAL_STATUSES: PendingBuyTerminalExecutionStatus[] = ['filled', 'skipped', 'cancelled', 'expired']

function emptySummary(): Record<PendingBuyTerminalExecutionStatus, number> {
  return {
    filled: 0,
    skipped: 0,
    cancelled: 0,
    expired: 0,
  }
}

export function isPendingBuyTerminal(status: PendingBuyExecutionStatus | null | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as PendingBuyTerminalExecutionStatus)
}

export function applyPendingBuyExecutionEvents(
  items: PendingBuyExecutionItem[],
  events: PendingBuyExecutionEvent[],
): PendingBuyExecutionTransition {
  const eventBySymbol = new Map(events.map((event) => [event.symbol, event]))
  const summary = emptySummary()
  let changed = false

  const allItems = items.map((item) => {
    const event = eventBySymbol.get(item.symbol)
    if (!event) return { ...item, execution_status: item.execution_status ?? 'pending' }
    changed = true
    summary[event.status] += 1
    return {
      ...item,
      execution_status: event.status,
      watch_points: [
        ...(Array.isArray(item.watch_points) ? item.watch_points : []),
        `execution:${event.status}:${event.reason}`,
      ],
    }
  })

  return {
    allItems,
    activeItems: allItems.filter((item) => !isPendingBuyTerminal(item.execution_status)),
    summary,
    changed,
  }
}
