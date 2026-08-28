import assert from 'node:assert/strict'
import {
  COMPOSITE_OPTUNA_CONFIG_SOURCES,
  mergeCompositeOptunaCandidate,
} from './optunaConfigMerge'
import {
  DEFAULT_TRADING_CONFIG,
  mergeAlphaFrameworkConfig,
} from './tradingConfig'

const sources: Record<string, any> = {
  barrier: {
    upper_mult: 1.7,
    lower_mult: 0.8,
    upper_pct_cap: 0.11,
    lower_pct_cap: 0.06,
    max_days: 12,
  },
  signal: {
    strong_signal_score: 0.88,
    buy_signal_score: 0.66,
    hold_signal_score: 0.44,
    consensus_threshold: 0.72,
  },
  sltp: {
    sl_mult: 1.2,
    tp_mult: 2.4,
    trail_switch_3pct: 0.04,
    trail_switch_8pct: 0.09,
  },
  screener: {
    minPrice: 25,
    maxPrice: 900,
    minAvgVolume: 800,
    minDailyTurnover: 99_000_000,
  },
  conformal: {
    coverage: 0.93,
    min_calibration_size: 120,
    max_residuals: 700,
  },
  risk_params: {
    drawdown_halt: 0.14,
    max_position_pct: 0.18,
    risk_pct: 0.012,
  },
  rrg: {
    leading_bonus: 1.3,
    improving_bonus: 1.1,
    weakening_bonus: 0.2,
    lagging_penalty: -0.7,
  },
  alpha_framework: {
    allocation: {
      weights: {
        bull: { technical: 0.42 },
      },
    },
  },
}

assert.deepEqual(Object.keys(sources), [...COMPOSITE_OPTUNA_CONFIG_SOURCES])

const candidate = mergeCompositeOptunaCandidate(
  structuredClone(DEFAULT_TRADING_CONFIG),
  sources,
  mergeAlphaFrameworkConfig,
)

assert.equal(candidate.config.barrier.upperMult, 1.7)
assert.equal(candidate.config.signal.consensusThreshold, 0.72)
assert.equal(candidate.config.sltp.slMultBase, 1.2)
assert.equal(candidate.config.screener.minPrice, 25)
assert.equal(candidate.config.screener.minAvgVolume, DEFAULT_TRADING_CONFIG.screener.minAvgVolume, 'retired share-volume gate must ignore stale Optuna output')
assert.equal(candidate.config.screener.minDailyTurnover, DEFAULT_TRADING_CONFIG.screener.minDailyTurnover, 'execution-universe capacity floor must not be changed by alpha Optuna')
assert.equal((candidate.config.L2_formula as any).conformal_coverage, 0.93)
assert.equal(candidate.config.circuit.drawdownHalt, 0.14)
assert.equal(candidate.config.position.riskPctPerTrade, 0.012)
assert.equal(candidate.config.rrg.leadingBonus, 1.3)
assert.equal((candidate.config.alphaFramework.allocation.weights.bull as any).technical, 0.42)
assert(candidate.updatedFields.includes('barrier.upperMult'))
assert(candidate.updatedFields.includes('alphaFramework.allocation.weights'))

assert.throws(
  () => mergeCompositeOptunaCandidate(
    structuredClone(DEFAULT_TRADING_CONFIG),
    { ...sources, rrg: undefined },
    mergeAlphaFrameworkConfig,
  ),
  /missing sources: rrg/,
)
