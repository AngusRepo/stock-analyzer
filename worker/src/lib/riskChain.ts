/**
 * riskChain.ts — RiskFramework R2 Chain merge (2026-04-21)
 *
 * Runs all 7 Level-2 portfolio checkers in parallel (no early-return) and
 * merges via strict semantics:
 *   halt              = OR across layers
 *   maxPositionPct    = MIN across layers (strictest wins)
 *   buyConfThreshold  = MAX across layers (most conservative threshold)
 *   sellConfThreshold = MAX
 *   momentumZone      = last-set zone (P6 only sets this)
 *   reason            = concatenated, `[Px] reason` format
 *
 * vs legacy early-return (R1 shim):
 *   - If P1 SCALE triggers AND P5 HALT also would trigger → under legacy,
 *     P1 wins (returns early with reduced pos). Under chain, BOTH fire:
 *     halt=true (from P5) + pos=0 (halt overrides) + reason lists both.
 *   - If P1 passes and P3 triggers (HIGH vol) AND P6 triggers (RED zone)
 *     → legacy uses P3 (pos=4%). Chain uses MIN(4%, 8% × 0.3 = 2.4%) = 2.4%.
 *
 * Net effect: **strictly more conservative**. Intended production default.
 * KV flag `risk:use_chain=v0` rolls back to legacy.
 */
import type { TradingConfig } from './tradingConfig'
import type {
  CircuitBreakerState,
  LegacyLayerDeps,
  MomentumZone,
} from './riskTypes'
import { checkP1Mdd } from './riskChecks/p1Mdd'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { checkP5Losses } from './riskChecks/p5Losses'
import { checkP6Momentum } from './riskChecks/p6Momentum'
import { checkP7Streak } from './riskChecks/p7Streak'

export interface AggregatedPortfolioState extends CircuitBreakerState {
  triggeredLayers: string[]
  haltReasons: string[]
}

export async function runPortfolioChecks(
  db: D1Database,
  cfg: TradingConfig,
  kv: KVNamespace | undefined,
  deps: LegacyLayerDeps,
): Promise<AggregatedPortfolioState> {
  // Run all 7 in parallel — none depend on each other's output.
  const [p1, p2, p3, p4, p5, p6, p7] = await Promise.all([
    checkP1Mdd(db, cfg, deps),
    checkP2Accuracy(db, kv, cfg, deps),
    checkP3MarketRisk(db, cfg, deps),
    checkP4Breadth(db, cfg, deps),
    checkP5Losses(db, deps),
    checkP6Momentum(db, deps),
    checkP7Streak(db, cfg, deps),
  ])

  const entries: Array<[string, CircuitBreakerState | null]> = [
    ['P1', p1], ['P2', p2], ['P3', p3], ['P4', p4],
    ['P5', p5], ['P6', p6], ['P7', p7],
  ]

  let halt = false
  const haltReasons: string[] = []
  let minPosPct = deps.defaults.maxPositionPct
  let maxBuyConf = deps.defaults.buyConfThreshold
  let maxSellConf = deps.defaults.sellConfThreshold
  let momentumZone: MomentumZone | undefined
  const reasons: string[] = []
  const triggeredLayers: string[] = []

  for (const [id, r] of entries) {
    if (!r) continue
    triggeredLayers.push(id)
    if (r.halt) {
      halt = true
      if (r.reason) haltReasons.push(`[${id}] ${r.reason}`)
    }
    minPosPct = Math.min(minPosPct, r.maxPositionPct)
    maxBuyConf = Math.max(maxBuyConf, r.buyConfThreshold)
    maxSellConf = Math.max(maxSellConf, r.sellConfThreshold)
    if (r.momentumZone) momentumZone = r.momentumZone
    if (r.reason && !r.halt) reasons.push(`[${id}] ${r.reason}`)
  }

  if (triggeredLayers.length > 0) {
    console.log(
      `[RiskChain] triggered ${triggeredLayers.join('+')} → ` +
      `halt=${halt} posPct=${(minPosPct * 100).toFixed(1)}% ` +
      `buyConf=${maxBuyConf.toFixed(3)} sellConf=${maxSellConf.toFixed(3)}`
    )
  }

  return {
    halt,
    haltReasons,
    maxPositionPct: halt ? 0 : minPosPct,
    buyConfThreshold: maxBuyConf,
    sellConfThreshold: maxSellConf,
    momentumZone,
    triggeredLayers,
    reason: halt ? haltReasons.join(' | ') : reasons.join(' | '),
  }
}
