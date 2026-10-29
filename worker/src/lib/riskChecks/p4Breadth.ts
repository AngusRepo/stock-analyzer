/**
 * p4Breadth.ts — Layer 4: canonical same-date market breadth gate.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import type { CanonicalMarketRiskContext } from '../marketRiskRuntime'
import { circuitPositionScales } from '../circuitPositionScales'

export async function checkP4Breadth(
  marketRisk: CanonicalMarketRiskContext,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps
  const scales = circuitPositionScales(cc)

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

  // Wei 10/29: only breadth collapse triggers here; bull alignment is evidence, not a trigger.
  if (!marketRisk.breadthLevel) return null

  const severe = marketRisk.breadthLevel === 'red' || marketRisk.breadthLevel === 'black'
  return {
    ...defaults,
    maxPositionPct: Math.min(
      defaults.maxPositionPct,
      scales
        ? defaults.maxPositionPct * scales.highVol * (severe ? scales.severeHighVol : 1)
        : severe ? cc.highVolReducedPosPct * 0.5 : cc.highVolReducedPosPct,
    ),
    targetExposurePct: marketRisk.targetExposureCap,
    deRiskExistingPositions: marketRisk.deRiskExistingPositions,
    reason: `breadth ${marketRisk.breadthLevel}: advance_ratio=${marketRisk.advanceRatio?.toFixed(4) ?? 'na'} bull_alignment=${marketRisk.bullAlignmentRatio?.toFixed(4) ?? 'na'}`,
  }
}
