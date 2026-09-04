/**
 * p4Breadth.ts — Layer 4: canonical same-date market breadth gate.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import type { CanonicalMarketRiskContext } from '../marketRiskRuntime'

export async function checkP4Breadth(
  marketRisk: CanonicalMarketRiskContext,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps

  if (marketRisk.status === 'blocked') {
    const breadthBlockers = marketRisk.blockers.filter((item) => item.includes('breadth'))
    if (!breadthBlockers.length) return null
    return {
      ...defaults,
      halt: true,
      reason: `P4 risk check unavailable: ${breadthBlockers.join(',')}`,
      maxPositionPct: 0,
      buyConfThreshold: 1,
      sellConfThreshold: 1,
      targetExposurePct: null,
      deRiskExistingPositions: false,
    }
  }

  const thresholdRaw = Number(cc.bullAlignmentThreshold ?? 20)
  const bullAlignmentThreshold = thresholdRaw > 1 ? thresholdRaw / 100 : thresholdRaw
  const bullAlignment = marketRisk.bullAlignmentRatio
  const bullAlignmentTriggered = bullAlignment != null && bullAlignment < bullAlignmentThreshold
  if (!marketRisk.breadthLevel && !bullAlignmentTriggered) return null

  const severe = marketRisk.breadthLevel === 'red' || marketRisk.breadthLevel === 'black'
  return {
    ...defaults,
    maxPositionPct: Math.min(
      defaults.maxPositionPct,
      severe ? cc.highVolReducedPosPct * 0.5 : cc.highVolReducedPosPct,
    ),
    targetExposurePct: marketRisk.targetExposureCap,
    deRiskExistingPositions: marketRisk.deRiskExistingPositions,
    reason: `breadth ${marketRisk.breadthLevel ?? 'weak'}: advance_ratio=${marketRisk.advanceRatio?.toFixed(4) ?? 'na'} bull_alignment=${bullAlignment?.toFixed(4) ?? 'na'}`,
  }
}
