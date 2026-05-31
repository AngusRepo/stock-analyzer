import {
  DEFAULT_HOLDING_EXIT_PARAMS,
  buildHoldingExitReview,
  buildHoldingExitReviewCandidate,
} from './holdingExitReview'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const position = {
  symbol: '2408',
  shares: 3000,
  avg_cost: 100,
  entry_price: 100,
  initial_stop: 92,
  trailing_stop: 104,
  highest_since_entry: 118,
  tp1_price: 110,
  tp2_price: 125,
  tp1_hit: 1,
  original_shares: 5000,
  entry_date: '2026-05-01',
  stop_multiplier: 2,
}

const partialReview = buildHoldingExitReview({
  position,
  currentPrice: 112,
  atr14: 3,
  baseline: { action: 'hold', reason: 'no trigger' },
  features: {
    brokerNetAmount5d: -22_000_000,
    brokerConcentrationDelta5d: -0.16,
    institutionalNetAmount5d: -18_000_000,
    obvTemperature60: 18,
    supportBreakPct: 0.025,
    mfePct: 0.18,
    givebackPct: 0.09,
    regime: 'volatile',
  },
})

assert(partialReview.action === 'partial_exit', 'test setup should produce a partial holding-review exit')

{
  const candidate = buildHoldingExitReviewCandidate(partialReview, {
    allowSellActions: true,
    position,
    sellActions: DEFAULT_HOLDING_EXIT_PARAMS.sellActions,
  })

  assert(candidate.action === 'partial_sell', 'guarded sell actions should activate partial review exits')
  assert(candidate.sellShares === 1000, 'partial sell should use adaptive ratio and round lot')
  assert(candidate.detail?.sell_action_guard, 'candidate detail should expose sell-action guard evidence')
}

{
  const candidate = buildHoldingExitReviewCandidate(partialReview, {
    allowSellActions: false,
    position,
    sellActions: DEFAULT_HOLDING_EXIT_PARAMS.sellActions,
  })

  assert(candidate.action === 'hold', 'disabled sell action guard should not sell')
}

{
  const lowConfidenceCandidate = buildHoldingExitReviewCandidate(
    { ...partialReview, confidence: DEFAULT_HOLDING_EXIT_PARAMS.sellActions.minConfidence - 0.01 },
    {
      allowSellActions: true,
      position,
      sellActions: DEFAULT_HOLDING_EXIT_PARAMS.sellActions,
    },
  )

  assert(lowConfidenceCandidate.action === 'hold', 'sell action guard should block low-confidence exits')
  assert(
    (lowConfidenceCandidate.detail?.sell_action_guard as any)?.reason === 'low_confidence',
    'low confidence block should be auditable',
  )
}

{
  const lowQualityCandidate = buildHoldingExitReviewCandidate(
    {
      ...partialReview,
      confidence: 0.9,
      features: {
        ...partialReview.features,
        featureQuality: {
          ...partialReview.features.featureQuality!,
          coverage: 0.5,
          missing: ['brokerFlow', 'institutionalChip', 'moneyFlow'],
        },
      },
    },
    {
      allowSellActions: true,
      position,
      sellActions: DEFAULT_HOLDING_EXIT_PARAMS.sellActions,
    },
  )

  assert(lowQualityCandidate.action === 'hold', 'sell action guard should block low-quality feature coverage')
  assert(
    String((lowQualityCandidate.detail?.sell_action_guard as any)?.reason).includes('feature_quality'),
    'feature-quality sell block should be auditable',
  )
}

{
  const fullReview = buildHoldingExitReview({
    position,
    currentPrice: 104,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: -35_000_000,
      brokerConcentrationDelta5d: -0.30,
      institutionalNetAmount5d: -28_000_000,
      obvTemperature60: 10,
      supportBreakPct: 0.06,
      mfePct: 0.20,
      givebackPct: 0.12,
      regime: 'volatile',
    },
  })
  assert(fullReview.action === 'full_exit', 'test setup should produce a full holding-review exit')

  const candidate = buildHoldingExitReviewCandidate(fullReview, {
    allowSellActions: true,
    position,
    sellActions: DEFAULT_HOLDING_EXIT_PARAMS.sellActions,
  })

  assert(candidate.action === 'full_sell', 'guarded sell actions should activate full review exits')
}
