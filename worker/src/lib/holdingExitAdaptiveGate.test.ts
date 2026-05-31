import assert from 'node:assert/strict'
import { DEFAULT_HOLDING_EXIT_PARAMS, buildHoldingExitReview } from './holdingExitReview'

const position = {
  symbol: '2408',
  shares: 1000,
  avg_cost: 100,
  entry_price: 100,
  initial_stop: 92,
  trailing_stop: 130,
  highest_since_entry: 132,
  tp1_price: 110,
  tp2_price: 125,
  tp1_hit: 1,
  original_shares: 1000,
  entry_date: '2026-05-01',
  stop_multiplier: 2,
}

const fullRiskFeatures = {
  brokerNetAmount5d: -40_000_000,
  brokerConcentrationDelta5d: -0.30,
  institutionalNetAmount5d: -40_000_000,
  obvTemperature60: 0,
  supportBreakPct: 0.0275,
  mfePct: 0.20,
  givebackPct: 0.20,
  regime: 'volatile' as const,
}

const loweredGateParams = {
  ...DEFAULT_HOLDING_EXIT_PARAMS,
  actionGates: {
    ...DEFAULT_HOLDING_EXIT_PARAMS.actionGates,
    fullExitStructureMin: 0.50,
  },
}

const defaultGateReview = buildHoldingExitReview({
  position,
  currentPrice: 112,
  atr14: 3,
  baseline: { action: 'hold', reason: 'no trigger' },
  features: fullRiskFeatures,
  params: DEFAULT_HOLDING_EXIT_PARAMS,
})

const loweredGateReview = buildHoldingExitReview({
  position,
  currentPrice: 112,
  atr14: 3,
  baseline: { action: 'hold', reason: 'no trigger' },
  features: fullRiskFeatures,
  params: loweredGateParams,
})

assert(defaultGateReview.factors.structure > 0.54 && defaultGateReview.factors.structure < 0.56, 'fixture should sit below default full-exit structure gate')
assert.equal(defaultGateReview.action, 'partial_exit', 'default action gate should avoid full exit below structure gate')
assert.equal(loweredGateReview.action, 'full_exit', 'adaptive action gate should allow full exit after learned gate change')

const stricterReasonParams = {
  ...DEFAULT_HOLDING_EXIT_PARAMS,
  reasonCutoffs: {
    ...DEFAULT_HOLDING_EXIT_PARAMS.reasonCutoffs,
    moneyFlow: 0.80,
    giveback: 0.95,
  },
}

const stricterReasonReview = buildHoldingExitReview({
  position,
  currentPrice: 112,
  atr14: 3,
  baseline: { action: 'hold', reason: 'no trigger' },
  features: {
    brokerNetAmount5d: 0,
    brokerConcentrationDelta5d: 0,
    institutionalNetAmount5d: 0,
    obvTemperature60: 30,
    supportBreakPct: 0,
    mfePct: 0.20,
    givebackPct: 0.15,
    regime: 'sideways',
  },
  params: stricterReasonParams,
})

assert(!stricterReasonReview.reasons.includes('money_flow_weakness'), 'reason cutoff should be adaptive, not fixed at 0.35')
assert(!stricterReasonReview.reasons.includes('giveback_risk'), 'giveback reason cutoff should be adaptive, not fixed at 0.30')
