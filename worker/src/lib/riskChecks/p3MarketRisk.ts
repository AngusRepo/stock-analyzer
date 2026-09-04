/**
 * p3MarketRisk.ts — Layer 3: canonical market-wide risk gate.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import type { CanonicalMarketRiskContext } from '../marketRiskRuntime'

export async function checkP3MarketRisk(
  marketRisk: CanonicalMarketRiskContext,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps

  if (marketRisk.status === 'blocked') {
    return {
      ...defaults,
      halt: true,
      reason: `P3 risk check unavailable: ${marketRisk.blockers.join(',') || 'canonical_market_risk_blocked'}`,
      maxPositionPct: 0,
      buyConfThreshold: 1,
      sellConfThreshold: 1,
      targetExposurePct: null,
      deRiskExistingPositions: false,
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
  if (marketRisk.level === 'black') {
    return {
      ...defaults,
      ...shared,
      halt: true,
      maxPositionPct: 0,
      buyConfThreshold: 1,
      reason: `canonical market risk black: ${marketRisk.reasons.join(' | ')}`,
    }
  }
  if (marketRisk.level === 'red') {
    return {
      ...defaults,
      ...shared,
      maxPositionPct: Math.min(defaults.maxPositionPct, cc.highVolReducedPosPct * 0.5),
      reason: `canonical market risk red: ${marketRisk.reasons.join(' | ')}`,
    }
  }
  if (marketRisk.level === 'orange') {
    return {
      ...defaults,
      ...shared,
      maxPositionPct: Math.min(defaults.maxPositionPct, cc.highVolReducedPosPct),
      reason: `canonical market risk orange: ${marketRisk.reasons.join(' | ')}`,
    }
  }
  return null
}
