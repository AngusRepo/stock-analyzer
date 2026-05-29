import type { Bindings } from '../types'
import { twToday } from './dateUtils'

export interface PaperExecutionEventInput {
  accountId?: number
  tradeDate?: string
  symbol?: string | null
  side?: 'buy' | 'sell' | null
  eventType: 'pending_buy' | 'paper_order' | 'debate' | 'snapshot_audit' | 'finlab_preview' | 'finlab_l5_market_data' | 'finlab_execution_preview' | 'paper_broker_reconciliation' | 'intraday_technical_decision'
  status: string
  reason?: string | null
  detail?: Record<string, unknown> | null
  orderId?: number | null
  pendingRunId?: number | null
  source?: string | null
}

export function normalizePaperExecutionEvent(input: PaperExecutionEventInput): Required<PaperExecutionEventInput> {
  return {
    accountId: input.accountId ?? 1,
    tradeDate: input.tradeDate ?? twToday(),
    symbol: input.symbol ?? null,
    side: input.side ?? null,
    eventType: input.eventType,
    status: String(input.status || 'unknown'),
    reason: input.reason ?? null,
    detail: input.detail ?? null,
    orderId: input.orderId ?? null,
    pendingRunId: input.pendingRunId ?? null,
    source: input.source ?? null,
  }
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

export async function recordPaperExecutionEvent(
  env: Pick<Bindings, 'DB'>,
  input: PaperExecutionEventInput,
): Promise<void> {
  const event = normalizePaperExecutionEvent(input)
  try {
    await env.DB.prepare(`
      INSERT INTO paper_execution_events
        (account_id, trade_date, symbol, side, event_type, status, reason,
         detail_json, order_id, pending_run_id, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      event.accountId,
      event.tradeDate,
      event.symbol,
      event.side,
      event.eventType,
      event.status,
      event.reason,
      event.detail ? JSON.stringify(event.detail) : null,
      event.orderId,
      event.pendingRunId,
      event.source,
    ).run()
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn(`[PaperExecutionEvents] insert failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function recordPaperExecutionEvents(
  env: Pick<Bindings, 'DB'>,
  events: PaperExecutionEventInput[],
): Promise<void> {
  for (const event of events) {
    await recordPaperExecutionEvent(env, event)
  }
}
