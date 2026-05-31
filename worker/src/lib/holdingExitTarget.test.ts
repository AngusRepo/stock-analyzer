import { buildHoldingExitReview } from './holdingExitReview'
import { buildMovingTakeProfitTarget } from './holdingExitTarget'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const position = {
  symbol: '2408',
  shares: 1000,
  avg_cost: 100,
  entry_price: 100,
  initial_stop: 92,
  trailing_stop: 108,
  highest_since_entry: 121,
  tp1_price: 110,
  tp2_price: 120,
  tp1_hit: 1,
  original_shares: 1000,
  entry_date: '2026-05-01',
  stop_multiplier: 2,
}

{
  const review = buildHoldingExitReview({
    position,
    currentPrice: 121,
    atr14: 3,
    baseline: { action: 'full_sell', reason: 'TP2 take profit @ 121.0 21.0%' },
    features: {
      brokerNetAmount5d: 8_000_000,
      brokerConcentrationDelta5d: 0.04,
      institutionalNetAmount5d: 5_000_000,
      obvTemperature60: 68,
      supportBreakPct: 0,
      mfePct: 0.21,
      givebackPct: 0,
      regime: 'bull',
    },
  })
  const decision = buildMovingTakeProfitTarget({
    position,
    currentPrice: 121,
    atr14: 3,
    review,
    staticBaseline: { action: 'full_sell', reason: 'TP2 take profit @ 121.0 21.0%' },
  })

  assert(decision.action === 'move_tp2', 'low exit-risk TP2 hit should move target instead of fixed TP2 exit')
  assert((decision.nextTp2Price ?? 0) > (position.tp2_price ?? 0), 'moving target must raise TP2')
  assert(decision.baselineCounterfactual.action === 'full_sell', 'fixed TP2 baseline must remain inspectable')
}

{
  const review = buildHoldingExitReview({
    position,
    currentPrice: 121,
    atr14: 3,
    baseline: { action: 'full_sell', reason: 'TP2 take profit @ 121.0 21.0%' },
    features: {
      brokerNetAmount5d: -28_000_000,
      brokerConcentrationDelta5d: -0.2,
      institutionalNetAmount5d: -16_000_000,
      obvTemperature60: 25,
      supportBreakPct: 0.04,
      mfePct: 0.21,
      givebackPct: 0.08,
      regime: 'volatile',
    },
  })
  const decision = buildMovingTakeProfitTarget({
    position,
    currentPrice: 121,
    atr14: 3,
    review,
    staticBaseline: { action: 'full_sell', reason: 'TP2 take profit @ 121.0 21.0%' },
  })

  assert(decision.action === 'hold', 'high exit-risk TP2 hit must not move target')
  assert(decision.reason.includes('exit_risk'), 'blocked target move should explain exit-risk reason')
}

{
  const review = buildHoldingExitReview({
    position,
    currentPrice: 121,
    atr14: 3,
    baseline: { action: 'full_sell', reason: 'TP2 take profit @ 121.0 21.0%' },
    features: {
      supportBreakPct: 0,
      mfePct: 0.21,
      givebackPct: 0,
      regime: 'bull',
    },
  })
  const decision = buildMovingTakeProfitTarget({
    position,
    currentPrice: 121,
    atr14: 3,
    review,
    staticBaseline: { action: 'full_sell', reason: 'TP2 take profit @ 121.0 21.0%' },
  })

  assert(decision.action === 'hold', 'missing broker/chip/money-flow evidence should block moving TP2')
  assert(decision.reason.includes('feature_quality'), 'feature-quality block should be auditable')
}
