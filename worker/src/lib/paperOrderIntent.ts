import type { Bindings } from '../types'

const ACCOUNT_ID = 1

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

export interface PaperOrderIntent {
  acquired: boolean
  intentKey: string
  fallback: boolean
}

export function buildPaperBuyIntentKey(tradeDate: string, symbol: string): string {
  return `${ACCOUNT_ID}:${tradeDate}:${symbol}:buy:auto_ml`
}

export async function acquirePaperBuyIntent(
  env: Bindings,
  tradeDate: string,
  symbol: string,
): Promise<PaperOrderIntent> {
  const intentKey = buildPaperBuyIntentKey(tradeDate, symbol)
  try {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO paper_order_intents
        (intent_key, account_id, trade_date, symbol, side, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'buy', 'auto_ml', 'running', datetime('now'), datetime('now'))`,
    ).bind(intentKey, ACCOUNT_ID, tradeDate, symbol).run()
    return {
      acquired: Number(result.meta?.changes ?? 0) > 0,
      intentKey,
      fallback: false,
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
    return { acquired: true, intentKey, fallback: true }
  }
}

export async function completePaperBuyIntent(
  env: Bindings,
  intentKey: string,
  status: 'filled' | 'failed',
  orderId?: number | null,
  errorMessage?: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE paper_order_intents
          SET status=?, order_id=?, error_message=?, updated_at=datetime('now')
        WHERE intent_key=?`,
    ).bind(status, orderId ?? null, errorMessage ?? null, intentKey).run()
  } catch (error) {
    if (!isMissingTableError(error)) throw error
  }
}
