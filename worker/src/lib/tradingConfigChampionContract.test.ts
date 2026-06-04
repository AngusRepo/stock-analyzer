import assert from 'node:assert'
import { buildChampionTradingConfig, validateTradingConfig } from './tradingConfig'

const champion = buildChampionTradingConfig(null)

assert.deepEqual(validateTradingConfig(champion), [], 'default champion trading config must validate cleanly')
assert.equal(
  champion.alphaFramework.allocation.engine,
  'sparse_tangent_inverse_risk',
  'champion allocation engine must be sparse_tangent_inverse_risk',
)
assert.equal(
  champion.alphaFramework.allocation.controller,
  'OnlinePortfolioBandit',
  'champion allocator controller must be OnlinePortfolioBandit',
)
assert.equal(
  champion.ensemble_v2.topKOverrideEnabled,
  false,
  'legacy top-k override must stay disabled in champion config',
)
assert.equal(
  champion.ensemble_v2.allowLegacyTopKOverride,
  false,
  'legacy top-k override rollback flag must stay disabled by default',
)

const restored = buildChampionTradingConfig({
  alpha_framework: {
    allocation: {
      buy_signal_count: 5,
      slate_size: 12,
      score_round_decimals: 2,
      weights: {
        bull: {
          trend_following: 0.5,
          breakout_vol_expansion: 0.3,
          mean_reversion: 0.1,
          defensive_accumulation: 0.1,
        },
      },
    },
  },
  ensemble_v2: {
    topKOverrideEnabled: true,
    allowLegacyTopKOverride: false,
  },
})

assert.deepEqual(validateTradingConfig(restored), [], 'restored champion config must fill missing nested defaults')
assert.equal(restored.alphaFramework.allocation.buySignalCount, 5)
assert.equal(restored.alphaFramework.allocation.slateSize, 12)
assert.equal(restored.alphaFramework.allocation.scoreRoundDecimals, 2)
assert.equal(restored.alphaFramework.allocation.weights.bull.trend_following, 0.5)
assert.equal(
  restored.alphaFramework.allocation.weights.bear.defensive_accumulation,
  champion.alphaFramework.allocation.weights.bear.defensive_accumulation,
  'missing regime weights must be filled from champion defaults',
)
assert.equal(
  restored.ensemble_v2.allowLegacyTopKOverride,
  false,
  'legacy top-k rollback flag must not be enabled by materialization',
)
