/**
 * p3MarketRisk.ts — Layer 3: Market-wide risk gate (HIGH/VERY_HIGH → shrink pos)
 * 2026-04-21 R1 extract from paper.ts L3.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

export async function checkP3MarketRisk(
  db: D1Database,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps

  const marketRisk = await db.prepare(
    'SELECT risk_level FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  const riskStr = (marketRisk?.risk_level ?? '').toString().toUpperCase()
  const isHighVol = riskStr === 'HIGH' || riskStr === 'VERY_HIGH'
  if (!isHighVol) return null

  console.warn(`[CircuitBreaker] Layer3: market risk ${marketRisk?.risk_level}, reducing max position to ${(cc.highVolReducedPosPct * 100).toFixed(0)}%`)
  return { ...defaults, maxPositionPct: cc.highVolReducedPosPct }
}
