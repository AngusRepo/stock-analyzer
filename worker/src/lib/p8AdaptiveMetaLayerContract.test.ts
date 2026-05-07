import {
  ADAPTIVE_META_LAYER_GOVERNANCE,
  DEFAULT_ADAPTIVE_PARAMS,
  getAdaptiveParamsForRegime,
  normalizeAdaptiveParams,
  resolveAdaptiveParamsForRegime,
  setAdaptiveParams,
} from './adaptiveConfig'
import { ALPHA_PREDICTION_MODEL_NAMES } from './recommendationContext'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const normalized = normalizeAdaptiveParams({
  confidence_delta: 0.03,
  position_pct_delta: 0.01,
  bandit_context: { reward_ledger: 'paper_orders.sell_5d', decision: 'reward_ledger_ok' },
  computed_at: '2026-05-05T01:00:00.000Z',
  version: 12,
  circuit: { drawdownHalt: 0.10 },
  alphaFramework: { allocation: { slateSize: 99 } },
} as any, { source: 'ml-controller', fallback: false })

assert(normalized.confidence_delta === 0.03, 'adaptive params must preserve allowed daily deltas')
assert(normalized.provenance.owner === 'ml-controller', 'adaptive params owner must be ml-controller')
assert(normalized.provenance.source === 'ml-controller', 'adaptive params must record source')
assert(normalized.provenance.update_frequency === 'daily_after_verify', 'adaptive params must expose update frequency')
assert(normalized.provenance.fallback === false, 'controller adaptive params must not be marked fallback')
assert(normalized.bandit_context?.reward_ledger === 'paper_orders.sell_5d', 'LinUCB protection must expose reward ledger provenance')
assert(!Object.prototype.hasOwnProperty.call(normalized, 'circuit'), 'adaptive params must not override circuit breaker hard boundaries')
assert(!Object.prototype.hasOwnProperty.call(normalized, 'alphaFramework'), 'adaptive params must not own alpha framework production config')

const legacyNormalized = normalizeAdaptiveParams({
  confidence_delta: 0.01,
  computed_at: '2026-05-04T10:00:00.000Z',
  version: 4,
} as any)
assert(legacyNormalized.provenance.fallback === true, 'legacy adaptive params without provenance must be treated as fallback/needs refresh')
assert(legacyNormalized.provenance.source === 'unknown', 'legacy adaptive params without provenance should expose unknown source')

const resolved = resolveAdaptiveParamsForRegime({
  ...DEFAULT_ADAPTIVE_PARAMS,
  confidence_delta: 0.02,
  screener: { ml_shortlist_delta: 0 },
  regime_overrides: {
    bull: {
      confidence_delta: -0.01,
      screener: { ml_shortlist_delta: 5 },
    },
    volatile: {
      confidence_delta: 0.06,
      bandit_max_mult: 1.5,
    },
  },
}, 'bull_market')

assert(resolved.confidence_delta === -0.01, 'bull regime must resolve its own adaptive confidence delta')
assert(resolved.screener?.ml_shortlist_delta === 5, 'regime override must support screener sizing deltas')
assert(resolved.provenance.regime === 'bull', 'resolved adaptive params must record normalized regime')

const volatile = resolveAdaptiveParamsForRegime({
  ...DEFAULT_ADAPTIVE_PARAMS,
  bandit_max_mult: 2.5,
  regime_overrides: {
    volatile: { bandit_max_mult: 1.5 },
  },
}, 'volatile')

assert(volatile.bandit_max_mult === 1.5, 'volatile regime must be able to tighten LinUCB max multiplier')

assert(
  JSON.stringify(ADAPTIVE_META_LAYER_GOVERNANCE.alpha_vote_models) === JSON.stringify(ALPHA_PREDICTION_MODEL_NAMES),
  'meta governance alpha vote models must match recommendation voting contract',
)
assert(
  JSON.stringify(ADAPTIVE_META_LAYER_GOVERNANCE.state_space_overlays) === JSON.stringify(['KalmanFilter', 'MarkovSwitching']),
  'Kalman/Markov must remain state-space overlays, not alpha voters',
)
assert(
  ADAPTIVE_META_LAYER_GOVERNANCE.meta_optimizers.includes('GAOptimizer'),
  'GAOptimizer must be declared as meta optimizer governance, not a predictor',
)
for (const component of ['ARF', 'LinUCB', 'Conformal', 'Stacking', 'GAOptimizer', 'NeuralUCB', 'NeuralTS', 'OnlinePortfolioBandit', 'NeuCB']) {
  assert(
    typeof ADAPTIVE_META_LAYER_GOVERNANCE.adaptive_components[component] === 'string',
    `${component} must have an explicit P8 meta-layer role`,
  )
}

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

void (async () => {
  const kv = new FakeKV() as unknown as KVNamespace
  await setAdaptiveParams(kv, {
    ...DEFAULT_ADAPTIVE_PARAMS,
    confidence_delta: 0.01,
    bandit_max_mult: 2.5,
    regime_overrides: {
      volatile: {
        confidence_delta: 0.07,
        bandit_max_mult: 1.5,
      },
    },
  }, { source: 'ml-controller', fallback: false })
  await kv.put('ml:regime:meta', JSON.stringify({ label: 'volatile' }))

  const params = await getAdaptiveParamsForRegime(kv)
  assert(params.confidence_delta === 0.07, 'current regime metadata must drive adaptive threshold resolution')
  assert(params.bandit_max_mult === 1.5, 'current regime metadata must drive LinUCB protection resolution')
})()
