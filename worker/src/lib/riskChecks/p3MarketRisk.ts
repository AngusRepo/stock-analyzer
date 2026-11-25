/**
 * p3MarketRisk.ts — Layer 3: canonical market-wide risk gate.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import type { CanonicalMarketRiskContext } from '../marketRiskRuntime'
import { circuitPositionScales } from '../circuitPositionScales'

export async function checkP3MarketRisk(
  marketRisk: CanonicalMarketRiskContext,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps
  const scales = circuitPositionScales(cc)

  if (marketRisk.status === 'blocked') {
    return {
      ...defaults,
      halt: true,
      reason: `P3 risk check unavailable: ${marketRisk.blockers.join(',') || 'canonical_market_risk_blocked'}`,
      maxPositionPct: 0,
      buyConfThreshold: 1,
      sellConfThreshold: 1,
      // Blocked halts new risk; a config-unavailable runtime still carries its conservative de-risk target.
      targetExposurePct: marketRisk.targetExposureCap,
      deRiskExistingPositions: marketRisk.deRiskExistingPositions,
      marketRiskLevel: marketRisk.level,
      marketRiskScore: marketRisk.score,
      marketRiskDate: marketRisk.date,
      marketRiskStatus: marketRisk.status,
      marketRiskReasons: marketRisk.reasons,
      marketRiskBlockers: marketRisk.blockers,
    }
  }

  const shared = {
    targetExposurePct: marketRisk.targetExposureCap,
    deRiskExistingPositions: marketRisk.deRiskExistingPositions,
    marketRiskLevel: marketRisk.level,
    marketRiskScore: marketRisk.score,
    marketRiskDate: marketRisk.date,
    marketRiskStatus: marketRisk.status,
    marketRiskReasons: marketRisk.reasons,
    marketRiskBlockers: marketRisk.blockers,
  } as const
  // Black halts new buys unless KV trading:risk_config.portfolio.blackHaltsNewBuys is false; the runtime owns that
  // decision (haltNewBuys). A non-halting black then sizes like red.
  if (marketRisk.level === 'black' && marketRisk.haltNewBuys !== false) {
    return {
      ...defaults,
      ...shared,
      halt: true,
      maxPositionPct: 0,
      buyConfThreshold: 1,
      reason: `canonical market risk black: ${marketRisk.reasons.join(' | ')}`,
    }
  }
  if (marketRisk.level === 'red' || marketRisk.level === 'black') {
    return {
      ...defaults,
      ...shared,
      maxPositionPct: Math.min(defaults.maxPositionPct, scales
        ? defaults.maxPositionPct * scales.highVol * scales.severeHighVol
        : cc.highVolReducedPosPct * 0.5),
      reason: `canonical market risk ${marketRisk.level}: ${marketRisk.reasons.join(' | ')}`,
    }
  }
  if (marketRisk.level === 'orange') {
    return {
      ...defaults,
      ...shared,
      maxPositionPct: Math.min(defaults.maxPositionPct, scales
        ? defaults.maxPositionPct * scales.highVol
        : cc.highVolReducedPosPct),
      reason: `canonical market risk orange: ${marketRisk.reasons.join(' | ')}`,
    }
  }
  return null
}
