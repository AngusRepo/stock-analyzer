import { paperAccountId } from '../paperExecutionScope'
import { paperExecutionNow } from '../paperExecutionScope'
/**
 * p8DailyPnl.ts — Level 2 P8: Daily P&L loss gate (2026-04-21 R3)
 *
 * Compares today's unrealized + realized P&L vs yesterday equity. If loss
 * exceeds absolute NT$ limit OR % limit → halt. Reads paper_daily_snapshots.
 */
import type { RiskConfig } from '../riskConfig'
import type { CircuitBreakerState, LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import { failClosedRiskCheck } from './failClosed'

export interface DailyPnlContext {tradeDate:string;previousSession:string;currentNav:number;netExternalFlow:number}


export async function checkP8DailyPnl(
  db: D1Database,
  riskCfg: RiskConfig,
  deps: LegacyLayerDeps,
  context?: DailyPnlContext,
): Promise<LegacyLayerResult> {
  const { defaults } = deps
  const { dailyPnlLossLimit, dailyPnlLossLimitPct } = riskCfg.portfolio
  const tradeDate=context?.tradeDate ?? new Date(paperExecutionNow()+8*3600000).toISOString().slice(0,10)

  // Need at least yesterday's equity + today's current total_value snapshot.
  // paper_daily_snapshots is updated daily via 'daily-snapshot' cron.
  try {
  const { results: snaps } = await db.prepare(
    'SELECT date, total_value FROM paper_daily_snapshots WHERE account_id=? AND date<=? ORDER BY date DESC LIMIT 2'
  ).bind(paperAccountId(),tradeDate).all<{ date: string; total_value: number }>()

  if (!snaps || snaps.length < (context ? 1 : 2)) return null
  const [today] = snaps
  if(!context && today.date!==tradeDate) return null // Prior two closes are not today's loss.
  const yday=context ? snaps.find(s=>s.date===context.previousSession) : snaps[1]
  if (!yday?.total_value || yday.total_value <= 0) return null
  if(context && (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || context.previousSession>=tradeDate
    || !Number.isFinite(context.currentNav) || context.currentNav<=0 || !Number.isFinite(context.netExternalFlow)))
    throw new Error('daily_pnl_context_invalid')
  const pnl = (context?.currentNav ?? today.total_value) - yday.total_value - (context?.netExternalFlow ?? 0)
  const pnlPct = pnl / yday.total_value

  const hitAbs = pnl <= dailyPnlLossLimit
  const hitPct = pnlPct <= dailyPnlLossLimitPct
  if (!hitAbs && !hitPct) return null

  console.warn(
    `[P8] Daily P&L halt: pnl=${pnl.toFixed(0)} (${(pnlPct * 100).toFixed(2)}%) ` +
    `limits abs=${dailyPnlLossLimit} pct=${(dailyPnlLossLimitPct * 100).toFixed(2)}%`
  )
  const state: CircuitBreakerState = {
    halt: true,
    reason: `【P8】${tradeDate} vs ${yday.date} 當日虧損 ${pnl.toFixed(0)} NT$ (${(pnlPct * 100).toFixed(2)}%) abs=${hitAbs} pct=${hitPct}`,
    maxPositionPct: 0,
    buyConfThreshold: defaults.buyConfThreshold,
    sellConfThreshold: defaults.sellConfThreshold,
  }
  return state
  } catch(error) {return failClosedRiskCheck('P8',error,deps)}
}
