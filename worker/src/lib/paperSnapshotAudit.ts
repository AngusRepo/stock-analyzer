import { paperAccountId } from './paperExecutionScope'
import type { Bindings } from '../types'
import { sendDiscordNotification, writeSystemLog } from './notify'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { paperDomainDatabase } from './paperDomainDatabase'
import { databaseForDataDomain } from './dataDomainRegistry'


export interface PaperSnapshotAuditInput {
  date: string
  cash: number
  positionsValue: number
  totalValue: number
}

export interface PaperSnapshotAuditSummary {
  ok: boolean
  issue_count: number
  issues: Record<string, number>
}

export function buildPaperSnapshotAuditSummary(issues: Record<string, number>): PaperSnapshotAuditSummary {
  const normalized: Record<string, number> = {}
  for (const [key, value] of Object.entries(issues)) {
    const count = Number(value)
    if (Number.isFinite(count) && count > 0) normalized[key] = count
  }
  const issueCount = Object.values(normalized).reduce((sum, count) => sum + count, 0)
  return { ok: issueCount === 0, issue_count: issueCount, issues: normalized }
}

async function countRows(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ cnt: number }>()
  return Number(row?.cnt ?? 0)
}

export async function auditPaperSnapshotConsistency(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  input: PaperSnapshotAuditInput,
): Promise<PaperSnapshotAuditSummary> {
  const paperDb = paperDomainDatabase(env)
  const opsDb = databaseForDataDomain(env, 'ops')
  try {
    const issues = {
      negative_sell_total_cost: await countRows(
        paperDb,
        "SELECT COUNT(*) AS cnt FROM paper_orders WHERE account_id=? AND side='sell' AND total_cost < 0",
        paperAccountId(),
      ),
      settlement_missing_order: await countRows(
        paperDb,
        'SELECT COUNT(*) AS cnt FROM paper_settlements WHERE account_id=? AND (order_id IS NULL OR order_id <= 0)',
        paperAccountId(),
      ),
      nonpositive_settlement_amount: await countRows(
        paperDb,
        'SELECT COUNT(*) AS cnt FROM paper_settlements WHERE account_id=? AND amount <= 0',
        paperAccountId(),
      ),
      invalid_open_position: await countRows(
        paperDb,
        'SELECT COUNT(*) AS cnt FROM paper_positions WHERE account_id=? AND (shares <= 0 OR avg_cost <= 0)',
        paperAccountId(),
      ),
    }
    const summary = buildPaperSnapshotAuditSummary(issues)
    if (!summary.ok) {
      await writeSystemLog(opsDb, 'warn', 'paper-snapshot-audit', 'Paper snapshot consistency issues detected', {
        ...summary,
        date: input.date,
        cash: Math.round(input.cash),
        positions_value: Math.round(input.positionsValue),
        total_value: Math.round(input.totalValue),
      })
      await recordPaperExecutionEvent(env, {
        tradeDate: input.date,
        eventType: 'snapshot_audit',
        status: 'warn',
        reason: 'consistency_issues',
        detail: {
          ...summary,
          cash: Math.round(input.cash),
          positions_value: Math.round(input.positionsValue),
          total_value: Math.round(input.totalValue),
        },
        source: 'daily_snapshot',
      })
    }
    return summary
  } catch (error) {
    await writeSystemLog(opsDb, 'warn', 'paper-snapshot-audit', 'Paper snapshot audit failed', {
      date: input.date,
      error: error instanceof Error ? error.message : String(error),
    })
    return buildPaperSnapshotAuditSummary({ audit_failed: 1 })
  }
}

/**
 * O04: daily NAV cash-flow reconciliation. Cash only moves through settlement rows (trades) and
 * paid corporate cash, and shares only through filled orders and delivered stock entitlements.
 * Anything else between two dated valuations is a residual. The tolerance is a monitoring
 * threshold, not a trading decision.
 */
export const NAV_RECONCILIATION_TOLERANCE_NTD = 1

export interface NavValuationPoint {
  date: string
  cash: number
  nav: number
  positions: Record<string, number>
  marks: Record<string, number>
}

export interface NavCashFlows {
  /** Net cash change booked by trades in the window: sell proceeds minus buy costs. */
  tradeCash: number
  /** Paid corporate cash in the window. */
  corporateCash: number
  /** Net shares per symbol from filled orders in the window (buys minus sells). */
  tradeShares: Record<string, number>
  /** Whole shares delivered by stock entitlements in the window. */
  corporateShares: Record<string, number>
}

export interface NavCashFlowResidual {
  previous_date: string
  previous_nav: number
  nav: number
  cash_residual: number
  share_residuals: Record<string, number>
  share_residual_value: number
  residual: number
  tolerance: number
  within_tolerance: boolean
  trade_cash_flow: number
  corporate_cash: number
}

const roundCents = (value: number) => Math.round(value * 100) / 100

export function computeNavCashFlowResidual(
  previous: NavValuationPoint, current: NavValuationPoint, flows: NavCashFlows,
): NavCashFlowResidual {
  const cashResidual = current.cash - previous.cash - flows.tradeCash - flows.corporateCash
  const symbols = new Set([...Object.keys(previous.positions), ...Object.keys(current.positions),
    ...Object.keys(flows.tradeShares), ...Object.keys(flows.corporateShares)])
  const shareResiduals: Record<string, number> = {}
  let shareValue = 0
  for (const symbol of [...symbols].sort()) {
    const residual = (current.positions[symbol] ?? 0) - (previous.positions[symbol] ?? 0)
      - (flows.tradeShares[symbol] ?? 0) - (flows.corporateShares[symbol] ?? 0)
    if (residual === 0) continue
    shareResiduals[symbol] = residual
    const mark = current.marks[symbol] ?? previous.marks[symbol]
    // An unexplained share change without any mark cannot be valued: never call it zero.
    shareValue += Number.isFinite(mark) && mark > 0 ? residual * mark : Number.NaN
  }
  const residual = cashResidual + shareValue
  return {
    previous_date: previous.date, previous_nav: roundCents(previous.nav), nav: roundCents(current.nav),
    cash_residual: roundCents(cashResidual), share_residuals: shareResiduals,
    share_residual_value: roundCents(shareValue), residual: roundCents(residual),
    tolerance: NAV_RECONCILIATION_TOLERANCE_NTD,
    within_tolerance: Number.isFinite(residual) && Math.abs(residual) <= NAV_RECONCILIATION_TOLERANCE_NTD,
    trade_cash_flow: roundCents(flows.tradeCash), corporate_cash: roundCents(flows.corporateCash),
  }
}

function asNumberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const numeric = Number(raw)
    if (Number.isFinite(numeric)) out[key] = numeric
  }
  return out
}

export function navValuationPoint(date: string, valuation: Record<string, unknown>): NavValuationPoint | null {
  const cash = Number(valuation.cash)
  const nav = Number(valuation.nav)
  if (!Number.isFinite(cash) || !Number.isFinite(nav) || valuation.valuation_complete === false) return null
  return { date, cash, nav, positions: asNumberRecord(valuation.positions), marks: asNumberRecord(valuation.marks) }
}

async function loadNavCashFlows(db: D1Database, previousDate: string, date: string): Promise<NavCashFlows> {
  const accountId = paperAccountId()
  const { results: trades } = await db.prepare(`
    SELECT s.side AS side, s.amount AS amount, s.symbol AS symbol, o.shares AS shares
      FROM paper_settlements s LEFT JOIN paper_orders o ON o.id=s.order_id AND o.account_id=s.account_id
     WHERE s.account_id=? AND s.trade_date>? AND s.trade_date<=?
  `).bind(accountId, previousDate, date).all<{ side: string; amount: number; symbol: string | null; shares: number | null }>()
  const tradeShares: Record<string, number> = {}
  let tradeCash = 0
  for (const row of trades ?? []) {
    const sign = row.side === 'sell' ? 1 : -1
    tradeCash += sign * Number(row.amount)
    if (!row.symbol || row.shares == null || !Number.isFinite(Number(row.shares))) {
      throw new Error('paper_nav_reconciliation_order_missing:' + (row.symbol ?? '?'))
    }
    tradeShares[row.symbol] = (tradeShares[row.symbol] ?? 0) - sign * Number(row.shares)
  }
  const { results: corporate } = await db.prepare(`
    SELECT symbol, kind, cash_due, whole_shares_due FROM paper_corporate_entitlements_v1
     WHERE account_id=? AND settled=1 AND kind IN ('cash','stock')
       AND date(settled_at,'+8 hours')>? AND date(settled_at,'+8 hours')<=?
  `).bind(accountId, previousDate, date).all<{ symbol: string; kind: string; cash_due: number; whole_shares_due: number }>()
  let corporateCash = 0
  const corporateShares: Record<string, number> = {}
  for (const row of corporate ?? []) {
    if (row.kind === 'cash') corporateCash += Number(row.cash_due)
    else corporateShares[row.symbol] = (corporateShares[row.symbol] ?? 0) + Number(row.whole_shares_due ?? 0)
  }
  const { results: conversions } = await db.prepare(`
    SELECT symbol, detail_json FROM paper_execution_events
     WHERE account_id=? AND event_type='corporate_share_conversion' AND trade_date>? AND trade_date<=?
  `).bind(accountId, previousDate, date).all<{ symbol: string; detail_json: string }>()
  for (const row of conversions ?? []) {
    const detail = JSON.parse(row.detail_json) as { shares_before?: number; shares_after?: number }
    const delta = Number(detail.shares_after) - Number(detail.shares_before)
    if (!row.symbol || !Number.isFinite(delta)) throw new Error('paper_nav_reconciliation_conversion_invalid:' + (row.symbol ?? '?'))
    corporateShares[row.symbol] = (corporateShares[row.symbol] ?? 0) + delta
  }
  return { tradeCash, corporateCash, tradeShares, corporateShares }
}

/**
 * Records the reconciliation for this snapshot. Alerts only on the first write of a session;
 * a failure here never blocks the snapshot that was already persisted.
 */
export async function reconcilePaperNavCashFlow(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  input: { date: string; valuation: Record<string, unknown>; notify: boolean },
): Promise<NavCashFlowResidual | null> {
  const paperDb = paperDomainDatabase(env)
  try {
    const previousRow = await paperDb.prepare(`
      SELECT trade_date, detail_json FROM paper_execution_events
       WHERE account_id=? AND event_type='snapshot_audit' AND status='verified' AND reason='dated_marks_complete'
         AND trade_date<?
       ORDER BY trade_date DESC, id DESC LIMIT 1
    `).bind(paperAccountId(), input.date).first<{ trade_date: string; detail_json: string | null }>()
    const previous = previousRow?.detail_json
      ? navValuationPoint(previousRow.trade_date, JSON.parse(previousRow.detail_json)) : null
    const current = navValuationPoint(input.date, input.valuation)
    if (!previous || !current) {
      await recordPaperExecutionEvent(env, {
        tradeDate: input.date, eventType: 'snapshot_audit', status: 'skipped', reason: 'nav_reconciliation_unavailable',
        detail: { previous_date: previousRow?.trade_date ?? null, previous_valuation: Boolean(previous), current_valuation: Boolean(current) },
        source: 'daily_snapshot',
      })
      return null
    }
    const flows = await loadNavCashFlows(paperDb, previous.date, input.date)
    const result = computeNavCashFlowResidual(previous, current, flows)
    await recordPaperExecutionEvent(env, {
      tradeDate: input.date, eventType: 'snapshot_audit', status: result.within_tolerance ? 'verified' : 'warn',
      reason: 'nav_cash_flow_residual', detail: { ...result }, source: 'daily_snapshot',
    })
    if (!result.within_tolerance && input.notify) {
      await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
        `⚠️ Paper NAV 對帳差額 ${input.date}: residual=${result.residual} NTD (cash ${result.cash_residual}, ` +
        `shares ${JSON.stringify(result.share_residuals)}) vs ${result.previous_date}; tolerance ${result.tolerance} NTD`)
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeSystemLog(databaseForDataDomain(env, 'ops'), 'warn', 'paper-snapshot-audit', 'Paper NAV reconciliation failed', {
      date: input.date, error: message,
    })
    await recordPaperExecutionEvent(env, {
      tradeDate: input.date, eventType: 'snapshot_audit', status: 'warn', reason: 'nav_reconciliation_failed',
      detail: { error: message }, source: 'daily_snapshot',
    }).catch(() => undefined)
    if (input.notify) await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      `⚠️ Paper NAV 對帳無法完成 ${input.date}: ${message}`)
    return null
  }
}
