import type { Bindings } from '../types'

const ACCOUNT_ID = 1

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

export interface PaperOrderIntent {
  acquired: boolean
  intentKey: string
  fallback: boolean
  recovered?: boolean
  reason?: string
}

export interface PaperOrderIntentRow {
  status: string
  updated_at: string | null
}

export type PaperBuyIntentCompletionStatus = 'filled' | 'partial' | 'failed'

export function buildPaperBuyIntentKey(tradeDate: string, symbol: string): string {
  return `${ACCOUNT_ID}:${tradeDate}:${symbol}:buy:auto_ml`
}

function parseD1Date(value: string | null | undefined): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ts = new Date(normalized).getTime()
  return Number.isFinite(ts) ? ts : null
}

export function shouldRecoverPaperBuyIntent(
  row: PaperOrderIntentRow | null | undefined,
  now = new Date(),
  staleMs = 15 * 60_000,
): boolean {
  if (!row) return false
  if (row.status === 'failed') return true
  if (row.status !== 'running') return false
  const updatedAt = parseD1Date(row.updated_at)
  if (updatedAt == null) return false
  return now.getTime() - updatedAt >= staleMs
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
    if (Number(result.meta?.changes ?? 0) > 0) {
      return { acquired: true, intentKey, fallback: false }
    }

    const existing = await env.DB.prepare(
      'SELECT status, updated_at FROM paper_order_intents WHERE intent_key=? LIMIT 1',
    ).bind(intentKey).first<PaperOrderIntentRow>()
    if (!shouldRecoverPaperBuyIntent(existing)) {
      return { acquired: false, intentKey, fallback: false, reason: existing?.status ?? 'duplicate' }
    }

    const recover = await env.DB.prepare(
      `UPDATE paper_order_intents
          SET status='running', order_id=NULL, error_message=NULL, updated_at=datetime('now')
        WHERE intent_key=?
          AND (
            status='failed'
            OR (status='running' AND updated_at <= datetime('now', '-15 minutes'))
          )`,
    ).bind(intentKey).run()
    const recovered = Number(recover.meta?.changes ?? 0) > 0
    return { acquired: recovered, intentKey, fallback: false, recovered, reason: recovered ? 'recovered' : existing?.status ?? 'duplicate' }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
    return { acquired: false, intentKey, fallback: false, reason: 'paper_order_intents_missing' }
  }
}

export async function completePaperBuyIntent(
  env: Bindings,
  intentKey: string,
  status: PaperBuyIntentCompletionStatus,
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
    if (isMissingTableError(error)) throw new Error('paper_order_intents_missing')
    throw error
  }
}
