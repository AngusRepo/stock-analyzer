/**
 * p1Mdd.ts — Layer 1: 30d rolling drawdown gate (P1-9 MDD-based sizing)
 *
 * Extracted from paper.ts `checkCircuitBreakers()` L1 (2026-04-21, R1).
 * Behavior verbatim from original. DO NOT mutate logic here without updating
 * Sprint 5.1 parity tests.
 */
import type { TradingConfig } from '../tradingConfig'
import type { CircuitBreakerState, LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

const ACCOUNT_ID = 1

export async function checkP1Mdd(
  db: D1Database,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults, effectiveBuy } = deps

  const { results: snapshots } = await db.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 30'
  ).bind(ACCOUNT_ID).all<any>()

  if (!snapshots || snapshots.length < 3) return null

  const values = snapshots.map((s: any) => s.total_value as number)
  const current = values[0]
  const maxValue = Math.max(...values)
  const drawdown = maxValue > 0 ? (maxValue - current) / maxValue : 0

  if (drawdown > cc.drawdownHalt) {
    console.warn(`[CircuitBreaker] Layer1 HALT: drawdown ${(drawdown * 100).toFixed(1)}% > ${(cc.drawdownHalt * 100).toFixed(0)}%`)
    const haltConf = Math.max(effectiveBuy, cc.drawdownRaisedConf)
    const out: CircuitBreakerState = {
      halt: true,
      reason: `30日回撤 ${(drawdown * 100).toFixed(1)}% 超過 ${(cc.drawdownHalt * 100).toFixed(0)}% 上限`,
      maxPositionPct: 0,
      buyConfThreshold: haltConf,
      sellConfThreshold: haltConf,
    }
    return out
  }

  if (drawdown > cc.drawdownScaleStart) {
    // CPPI-style linear scaling (Black & Perold 1992 JEDC):
    // mult=1.0 at drawdownScaleStart, mult=0.0 at drawdownHalt, linear between.
    const mddMultiplier = Math.max(
      cc.mddMultFloor,
      (cc.drawdownHalt - drawdown) / (cc.drawdownHalt - cc.drawdownScaleStart)
    )
    const adjustedPosPct = cc.maxPositionPct * mddMultiplier
    const adjustedConf = drawdown > cc.drawdownHalt * cc.drawdownConfTriggerRatio
      ? Math.max(cc.drawdownRaisedConf, effectiveBuy)
      : effectiveBuy
    console.log(`[CircuitBreaker] Layer1 SCALE: drawdown ${(drawdown * 100).toFixed(1)}% → posPct ${(adjustedPosPct * 100).toFixed(1)}% (mult=${mddMultiplier.toFixed(2)})`)
    return {
      ...defaults,
      maxPositionPct: adjustedPosPct,
      buyConfThreshold: adjustedConf,
      reason: `MDD ${(drawdown * 100).toFixed(1)}% 動態縮減`,
    }
  }

  return null
}
