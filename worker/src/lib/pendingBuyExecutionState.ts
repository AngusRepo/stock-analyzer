import { formatDebateEvent, formatExecutionStatusEvent } from './executionEvent'

export type PendingBuyActiveExecutionStatus =
  | 'pending'
  | 'submitted'
  | 'requoted'
  | 'partially_filled'
  | 'stale_quote'
  | 'quote_unavailable'
export type PendingBuyTerminalExecutionStatus = 'filled' | 'skipped' | 'cancelled' | 'expired' | 'rejected'
export type PendingBuyExecutionStatus = PendingBuyActiveExecutionStatus | PendingBuyTerminalExecutionStatus

export interface PendingBuyExecutionItem {
  symbol: string
  debate_status?: string | null
  debate_verdict?: string | null
  execution_status?: PendingBuyExecutionStatus | null
  watch_points?: string[]
}

export interface PendingBuyPartialFillRemaining {
  requested: number
  filled: number
  remaining: number
}

export interface PendingBuyExecutionEvent {
  symbol: string
  status: PendingBuyTerminalExecutionStatus
  reason: string
  detail?: string | null
}

export interface PendingBuyExecutionStatusUpdate {
  symbol: string
  status: PendingBuyActiveExecutionStatus
  reason: string
  detail?: string | null
}

export interface PendingBuyExecutionTransition {
  allItems: PendingBuyExecutionItem[]
  activeItems: PendingBuyExecutionItem[]
  summary: Record<PendingBuyTerminalExecutionStatus, number>
  activeSummary: Record<PendingBuyActiveExecutionStatus, number>
  changed: boolean
}

const ACTIVE_STATUSES: PendingBuyActiveExecutionStatus[] = [
  'pending',
  'submitted',
  'requoted',
  'partially_filled',
  'stale_quote',
  'quote_unavailable',
]
const TERMINAL_STATUSES: PendingBuyTerminalExecutionStatus[] = ['filled', 'skipped', 'cancelled', 'expired', 'rejected']

function emptySummary(): Record<PendingBuyTerminalExecutionStatus, number> {
  return {
    filled: 0,
    skipped: 0,
    cancelled: 0,
    expired: 0,
    rejected: 0,
  }
}

function emptyActiveSummary(): Record<PendingBuyActiveExecutionStatus, number> {
  return {
    pending: 0,
    submitted: 0,
    requoted: 0,
    partially_filled: 0,
    stale_quote: 0,
    quote_unavailable: 0,
  }
}

function summarizeActive(items: PendingBuyExecutionItem[]): Record<PendingBuyActiveExecutionStatus, number> {
  const summary = emptyActiveSummary()
  for (const item of items) {
    const status = (item.execution_status ?? 'pending') as PendingBuyExecutionStatus
    if (ACTIVE_STATUSES.includes(status as PendingBuyActiveExecutionStatus)) {
      summary[status as PendingBuyActiveExecutionStatus] += 1
    }
  }
  return summary
}

export function isPendingBuyTerminal(status: PendingBuyExecutionStatus | null | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as PendingBuyTerminalExecutionStatus)
}

function isAllocatorExecutionNote(note: string): boolean {
  return note.startsWith('execution:pending:allocator_')
}

export function appendPendingBuyExecutionNote<T extends PendingBuyExecutionItem>(item: T, note: string): T {
  const points = Array.isArray(item.watch_points) ? item.watch_points : []
  const nextPointsBase = isAllocatorExecutionNote(note)
    ? points.filter((point) => !isAllocatorExecutionNote(point))
    : points
  if (nextPointsBase.includes(note)) return { ...item, execution_status: item.execution_status ?? 'pending' }
  return {
    ...item,
    execution_status: item.execution_status ?? 'pending',
    watch_points: [...nextPointsBase, note],
  }
}

function parsePartialFillDetail(detail: string | null | undefined): PendingBuyPartialFillRemaining | null {
  if (!detail) return null
  const parts = new Map<string, number>()
  for (const part of detail.split(';')) {
    const [rawKey, rawValue] = part.split('=')
    const key = rawKey?.trim()
    const value = Number(rawValue)
    if (key && Number.isFinite(value) && value >= 0) parts.set(key, value)
  }
  const requested = parts.get('requested')
  const filled = parts.get('filled')
  const remaining = parts.get('remaining')
  if (requested == null || filled == null || remaining == null) return null
  return { requested, filled, remaining }
}

export function extractPartialFillRemaining(item: PendingBuyExecutionItem): PendingBuyPartialFillRemaining | null {
  for (const point of item.watch_points ?? []) {
    const event = point.startsWith('execution:') ? point.split(':') : []
    if (event[1] !== 'partially_filled' || event[2] !== 'paper_order_partial_fill') continue
    const parsed = parsePartialFillDetail(event.slice(3).join(':'))
    if (parsed) return parsed
  }
  return null
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
      watch_points: appendPendingBuyExecutionNote(item, formatExecutionStatusEvent(event.status, event.reason, event.detail)).watch_points,
    }
  })

  return {
    allItems,
    activeItems: allItems.filter((item) => !isPendingBuyTerminal(item.execution_status)),
    summary,
    activeSummary: summarizeActive(allItems.filter((item) => !isPendingBuyTerminal(item.execution_status))),
    changed,
  }
}

export function applyPendingBuyExecutionStatusUpdates(
  items: PendingBuyExecutionItem[],
  updates: PendingBuyExecutionStatusUpdate[],
): PendingBuyExecutionTransition {
  const updateBySymbol = new Map(updates.map((update) => [update.symbol, update]))
  let changed = false

  const allItems = items.map((item) => {
    const update = updateBySymbol.get(item.symbol)
    if (!update || isPendingBuyTerminal(item.execution_status)) {
      return { ...item, execution_status: item.execution_status ?? 'pending' }
    }
    changed = true
    const noted = appendPendingBuyExecutionNote(
      item,
      formatExecutionStatusEvent(update.status, update.reason, update.detail),
    )
    return {
      ...noted,
      execution_status: update.status,
    }
  })
  const activeItems = allItems.filter((item) => !isPendingBuyTerminal(item.execution_status))

  return {
    allItems,
    activeItems,
    summary: emptySummary(),
    activeSummary: summarizeActive(activeItems),
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
    activeSummary: summarizeActive(allItems.filter((item) => !isPendingBuyTerminal(item.execution_status))),
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
