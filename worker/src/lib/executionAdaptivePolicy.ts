import type { L5QuoteQuality } from './finlabL5MarketData'

export type AdaptiveStrategyMode = 'breakout' | 'breakout_continuation' | 'pullback' | 'trend' | 'mean_reversion' | string

export interface AdaptiveExecutionBaseThresholds {
  minVolumeRatio: number
  minRangePosition: number
  maxEntryChasePct: number
  strongBreakoutMaxEntryChasePct: number
  strongBreakoutVolumeRatio?: number
  strongBreakoutRangePosition?: number
}

export interface AdaptiveExecutionPolicyInput {
  strategyMode?: AdaptiveStrategyMode | null
  marketRiskLevel?: string | null
  l5Quality?: L5QuoteQuality | null
  base: AdaptiveExecutionBaseThresholds
}

export interface AdaptiveExecutionPolicy {
  momentum: {
    minVolumeRatio: number
    minRangePosition: number
    strongBreakoutVolumeRatio: number
    strongBreakoutRangePosition: number
  }
  policy: {
    maxEntryChasePct: number
    strongBreakoutMaxEntryChasePct: number
  }
  envelopeBlockReason?: string
  notes: string[]
}

const WEAK_MARKET_LEVELS = new Set(['medium', 'high', 'orange', 'red', 'black', 'extreme', 'danger'])

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function modeBucket(value: AdaptiveStrategyMode | null | undefined): 'breakout' | 'breakout_continuation' | 'pullback' | 'trend' | 'mean_reversion' {
  const text = String(value ?? '').toLowerCase()
  if (text.includes('breakout_continuation') || text.includes('continuation')) return 'breakout_continuation'
  if (text.includes('breakout')) return 'breakout'
  if (text.includes('pullback')) return 'pullback'
  if (text.includes('mean') || text.includes('reversion')) return 'mean_reversion'
  return 'trend'
}

export function resolveAdaptiveExecutionPolicy(input: AdaptiveExecutionPolicyInput): AdaptiveExecutionPolicy {
  const bucket = modeBucket(input.strategyMode)
  const notes: string[] = [`strategy=${bucket}`]
  let minVolumeRatio = input.base.minVolumeRatio
  let minRangePosition = input.base.minRangePosition
  let strongBreakoutVolumeRatio = input.base.strongBreakoutVolumeRatio ?? 1.5
  let strongBreakoutRangePosition = input.base.strongBreakoutRangePosition ?? 0.7
  let maxEntryChasePct = input.base.maxEntryChasePct
  let strongBreakoutMaxEntryChasePct = input.base.strongBreakoutMaxEntryChasePct

  if (bucket === 'pullback' || bucket === 'mean_reversion') {
    minVolumeRatio = Math.min(minVolumeRatio, 0.55)
    minRangePosition = Math.min(minRangePosition, 0.12)
    maxEntryChasePct *= 0.5
    strongBreakoutMaxEntryChasePct *= 0.5
    notes.push('pullback_soft_volume_range')
  } else if (bucket === 'breakout') {
    minVolumeRatio = Math.max(minVolumeRatio, 1.2)
    minRangePosition = Math.max(minRangePosition, 0.5)
    strongBreakoutVolumeRatio = Math.max(strongBreakoutVolumeRatio, 1.5)
    strongBreakoutRangePosition = Math.max(strongBreakoutRangePosition, 0.7)
    notes.push('breakout_strict_confirmation')
  } else if (bucket === 'breakout_continuation') {
    minVolumeRatio = Math.max(minVolumeRatio, 1.0)
    minRangePosition = Math.max(minRangePosition, 0.35)
    maxEntryChasePct = Math.max(maxEntryChasePct, 0.01)
    strongBreakoutMaxEntryChasePct = Math.max(strongBreakoutMaxEntryChasePct, 0.02)
    strongBreakoutVolumeRatio = Math.max(strongBreakoutVolumeRatio, 1.3)
    strongBreakoutRangePosition = Math.max(strongBreakoutRangePosition, 0.6)
    notes.push('breakout_continuation_live_entry')
  } else if (bucket === 'trend') {
    minVolumeRatio = Math.min(minVolumeRatio, 0.75)
    maxEntryChasePct = Math.min(maxEntryChasePct, 0.0045)
    strongBreakoutMaxEntryChasePct = Math.min(strongBreakoutMaxEntryChasePct, 0.012)
    notes.push('trend_balanced_confirmation')
  }

  const marketRisk = String(input.marketRiskLevel ?? 'unknown').toLowerCase()
  if (WEAK_MARKET_LEVELS.has(marketRisk)) {
    minVolumeRatio *= (bucket === 'breakout' || bucket === 'breakout_continuation') ? 1.25 : 1.1
    minRangePosition = Math.min(0.85, minRangePosition + (bucket === 'pullback' ? 0.03 : 0.1))
    maxEntryChasePct *= 0.5
    strongBreakoutMaxEntryChasePct *= 0.5
    notes.push(`weak_market=${marketRisk}`)
  }

  let envelopeBlockReason: string | undefined
  if (input.l5Quality?.status === 'blocked') {
    envelopeBlockReason = input.l5Quality.reasons[0] ?? 'l5_quality_blocked'
    maxEntryChasePct = 0
    strongBreakoutMaxEntryChasePct = 0
    notes.push(`l5_block=${envelopeBlockReason}`)
  } else if (input.l5Quality?.status === 'degraded') {
    maxEntryChasePct *= 0.5
    strongBreakoutMaxEntryChasePct *= 0.5
    notes.push(`l5_degraded=${input.l5Quality.reasons.join(',')}`)
  }

  return {
    momentum: {
      minVolumeRatio: round(minVolumeRatio, 2),
      minRangePosition: round(minRangePosition, 2),
      strongBreakoutVolumeRatio: round(strongBreakoutVolumeRatio, 2),
      strongBreakoutRangePosition: round(strongBreakoutRangePosition, 2),
    },
    policy: {
      maxEntryChasePct: round(maxEntryChasePct),
      strongBreakoutMaxEntryChasePct: round(strongBreakoutMaxEntryChasePct),
    },
    envelopeBlockReason,
    notes,
  }
}
