import { formatDebateEvent, formatExecutionStatusEvent } from './executionEvent'

export type PendingBuyExecutionStatus = 'pending' | 'filled' | 'skipped' | 'cancelled' | 'expired'
export type PendingBuyTerminalExecutionStatus = Exclude<PendingBuyExecutionStatus, 'pending'>

export interface PendingBuyExecutionItem {
  symbol: string
  debate_status?: string | null
  debate_verdict?: string | null
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

export function appendPendingBuyExecutionNote<T extends PendingBuyExecutionItem>(item: T, note: string): T {
  const points = Array.isArray(item.watch_points) ? item.watch_points : []
  if (points.includes(note)) return { ...item, execution_status: item.execution_status ?? 'pending' }
  return {
    ...item,
    execution_status: item.execution_status ?? 'pending',
    watch_points: [...points, note],
  }
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
      watch_points: appendPendingBuyExecutionNote(item, formatExecutionStatusEvent(event.status, event.reason)).watch_points,
    }
  })

  return {
    allItems,
    activeItems: allItems.filter((item) => !isPendingBuyTerminal(item.execution_status)),
    summary,
    changed,
  }
}

export function applyPendingBuyDebateFailure(
  items: PendingBuyExecutionItem[],
  reason: string,
): PendingBuyExecutionTransition {
  const summary = emptySummary()
  let changed = false

  const allItems = items.map((item) => {
    if (isPendingBuyTerminal(item.execution_status)) {
      return { ...item, execution_status: item.execution_status ?? 'pending' }
    }

    changed = true
    summary.skipped += 1
    return appendPendingBuyExecutionNote(appendPendingBuyExecutionNote({
      ...item,
      debate_status: 'failed',
      debate_verdict: item.debate_verdict ?? 'PENDING',
      execution_status: 'skipped' as const,
    }, formatDebateEvent('failed', reason)), formatExecutionStatusEvent('skipped', reason))
  })

  return {
    allItems,
    activeItems: allItems.filter((item) => !isPendingBuyTerminal(item.execution_status)),
    summary,
    changed,
  }
}

export function applyPendingBuySlaExpiry(
  items: PendingBuyExecutionItem[],
  reason: string,
): PendingBuyExecutionTransition {
  const events = items
    .filter((item) => !isPendingBuyTerminal(item.execution_status))
    .map((item) => ({ symbol: item.symbol, status: 'expired' as const, reason }))
  return applyPendingBuyExecutionEvents(items, events)
}
