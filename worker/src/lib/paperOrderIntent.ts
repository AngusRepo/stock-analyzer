import { paperAccountId, paperExecutionDate } from './paperExecutionScope'
import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'


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
  return `${paperAccountId()}:${tradeDate}:${symbol}:buy:auto_ml`
}

function parseD1Date(value: string | null | undefined): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ts = new Date(normalized).getTime()
  return Number.isFinite(ts) ? ts : null
}

export function shouldRecoverPaperBuyIntent(
  row: PaperOrderIntentRow | null | undefined,
  now = paperExecutionDate(),
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
  targetRevision?: {planId:string; currentShares:number},
): Promise<PaperOrderIntent> {
  if (targetRevision && (!/^[a-f0-9]{64}$/.test(targetRevision.planId) || !Number.isSafeInteger(targetRevision.currentShares) || targetRevision.currentShares<0))
    throw new Error('l4_buy_intent_revision_invalid')
  const intentKey = buildPaperBuyIntentKey(tradeDate, symbol) + (targetRevision ? `:l4:${targetRevision.planId}:from:${targetRevision.currentShares}` : '')
  const revisionGuard = targetRevision ? ` AND EXISTS(SELECT 1 FROM l4_portfolio_head_v1 WHERE account_id=? AND plan_id=?)
    AND COALESCE((SELECT shares FROM paper_positions WHERE account_id=? AND symbol=?),0)=?` : ''
  const revisionArgs = targetRevision ? [paperAccountId(),targetRevision.planId,paperAccountId(),symbol,targetRevision.currentShares] : []
  try {
    const result = await paperDomainDatabase(env).prepare(
      `INSERT OR IGNORE INTO paper_order_intents
        (intent_key, account_id, trade_date, symbol, side, source, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'buy', 'auto_ml', 'running', datetime('now'), datetime('now') WHERE 1=1${revisionGuard}`,
    ).bind(intentKey, paperAccountId(), tradeDate, symbol,...revisionArgs).run()
    if (Number(result.meta?.changes ?? 0) > 0) {
      return { acquired: true, intentKey, fallback: false }
    }

    const existing = await paperDomainDatabase(env).prepare(
      'SELECT status, updated_at FROM paper_order_intents WHERE intent_key=? LIMIT 1',
    ).bind(intentKey).first<PaperOrderIntentRow>()
    if (!shouldRecoverPaperBuyIntent(existing)) {
      return { acquired: false, intentKey, fallback: false, reason: existing?.status ?? 'duplicate' }
    }

    const recover = await paperDomainDatabase(env).prepare(
      `UPDATE paper_order_intents
          SET status='running', order_id=NULL, error_message=NULL, updated_at=datetime('now')
        WHERE intent_key=?
          AND (
            status='failed'
            OR (status='running' AND updated_at <= datetime('now', '-15 minutes'))
          )${revisionGuard}`,
    ).bind(intentKey,...revisionArgs).run()
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
    await paperDomainDatabase(env).prepare(
      `UPDATE paper_order_intents
          SET status=?, order_id=?, error_message=?, updated_at=datetime('now')
        WHERE intent_key=?`,
    ).bind(status, orderId ?? null, errorMessage ?? null, intentKey).run()
  } catch (error) {
    if (isMissingTableError(error)) throw new Error('paper_order_intents_missing')
    throw error
  }
}

/** Append after the native buy order in the SAME D1 batch as its position. */
export function l4BuySettlementStatements(env:Bindings, input:{symbol:string;totalCost:number;tradeDate:string;
  settlementDate:string;intentKey:string;status:'partial'|'filled'}):D1PreparedStatement[] {
  const {symbol,totalCost,tradeDate,settlementDate,intentKey,status}=input
  return [
    paperDomainDatabase(env).prepare(`INSERT INTO paper_settlements
      (account_id,order_id,symbol,side,amount,trade_date,settlement_date)
      SELECT ?,id,?,'buy',?,?,? FROM paper_orders
       WHERE account_id=? AND symbol=? AND side='buy' AND json_extract(note,'$.intent_key')=?
       ORDER BY id DESC LIMIT 1`).bind(paperAccountId(),symbol,totalCost,tradeDate,settlementDate,
         paperAccountId(),symbol,intentKey),
    paperDomainDatabase(env).prepare(`UPDATE paper_order_intents
       SET status=?,order_id=(SELECT id FROM paper_orders WHERE account_id=? AND symbol=?
         AND side='buy' AND json_extract(note,'$.intent_key')=? ORDER BY id DESC LIMIT 1),
         error_message=NULL,updated_at=datetime('now') WHERE intent_key=?`)
      .bind(status,paperAccountId(),symbol,intentKey,intentKey),
  ]
}
