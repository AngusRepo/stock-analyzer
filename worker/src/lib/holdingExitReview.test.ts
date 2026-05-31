import { buildHoldingExitReview } from './holdingExitReview'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const basePosition = {
  symbol: '2408',
  shares: 1000,
  avg_cost: 100,
  entry_price: 100,
  initial_stop: 92,
  trailing_stop: 101,
  highest_since_entry: 118,
  tp1_price: 110,
  tp2_price: 125,
  tp1_hit: 0,
  original_shares: 1000,
  entry_date: '2026-05-01',
  stop_multiplier: 2,
}

{
  const review = buildHoldingExitReview({
    position: basePosition,
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: -18_000_000,
      brokerConcentrationDelta5d: -0.18,
      institutionalNetAmount5d: -12_000_000,
      obvTemperature60: 22,
      supportBreakPct: 0.04,
      mfePct: 0.18,
      givebackPct: 0.06,
      regime: 'sideways',
    },
  })

  assert(review.action === 'tighten_trail', 'moderate distribution plus giveback should tighten trail')
  assert((review.suggestedTrailingStop ?? 0) > (basePosition.trailing_stop ?? 0), 'tighten action should raise trailing stop')
  assert(review.baselineCounterfactual.action === 'hold', 'review must carry current-policy baseline action')
  assert(review.reasons.includes('broker_flow_distribution'), 'broker-flow reason should be exposed')
}

{
  const review = buildHoldingExitReview({
    position: { ...basePosition, trailing_stop: 111 },
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: -18_000_000,
      institutionalNetAmount5d: -12_000_000,
      obvTemperature60: 22,
      supportBreakPct: 0.04,
      mfePct: 0.18,
      givebackPct: 0.06,
      regime: 'bull',
    },
  })

  assert(review.action !== 'tighten_trail', 'review must not tighten when learned trail would not improve current trail')
  assert(review.baselineCounterfactual.reason === 'no trigger', 'baseline reason should remain inspectable')
}

