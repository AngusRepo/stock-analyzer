/**
 * p8DailyPnl.ts — Level 2 P8: Daily P&L loss gate (2026-04-21 R3)
 *
 * Compares today's unrealized + realized P&L vs yesterday equity. If loss
 * exceeds absolute NT$ limit OR % limit → halt. Reads paper_daily_snapshots.
 */
import type { RiskConfig } from '../riskConfig'
import type { CircuitBreakerState, LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

const ACCOUNT_ID = 1

export async function checkP8DailyPnl(
  db: D1Database,
  riskCfg: RiskConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const { defaults } = deps
  const { dailyPnlLossLimit, dailyPnlLossLimitPct } = riskCfg.portfolio

  // Need at least yesterday's equity + today's current total_value snapshot.
  // paper_daily_snapshots is updated daily via 'daily-snapshot' cron.
  const { results: snaps } = await db.prepare(
    'SELECT date, total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 2'
  ).bind(ACCOUNT_ID).all<{ date: string; total_value: number }>()

  if (!snaps || snaps.length < 2) return null
  const [today, yday] = snaps
  if (!yday?.total_value || yday.total_value <= 0) return null

  const pnl = today.total_value - yday.total_value
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
    reason: `【P8】當日虧損 ${pnl.toFixed(0)} NT$ (${(pnlPct * 100).toFixed(2)}%) 超過上限`,
    maxPositionPct: 0,
    buyConfThreshold: defaults.buyConfThreshold,
    sellConfThreshold: defaults.sellConfThreshold,
  }
  return state
}
