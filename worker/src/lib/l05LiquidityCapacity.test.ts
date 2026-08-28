import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  L05_LIQUIDITY_CAPACITY_POLICY,
  L05_LIQUIDITY_CAPACITY_POLICY_CANONICAL_JSON,
  L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM,
  evaluateL05LiquidityCapacity,
} from './l05LiquidityCapacity'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'

const expectedChecksum = `sha256:${createHash('sha256')
  .update(L05_LIQUIDITY_CAPACITY_POLICY_CANONICAL_JSON)
  .digest('hex')}`
assert.equal(L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM, expectedChecksum)
assert.equal(L05_LIQUIDITY_CAPACITY_POLICY.selection_policy, 'capacity_floor_no_topk')
assert.equal(L05_LIQUIDITY_CAPACITY_POLICY.legacy_min_avg_volume_decision_effect, false)
assert.equal(L05_LIQUIDITY_CAPACITY_POLICY.maturity_impact, 'none_no_reset')

const highPriceLowShareVolume = Array.from(
  { length: 20 },
  () => ({ close: 200, Trading_Volume: 100_000 }),
)
const highPriceReceipt = evaluateL05LiquidityCapacity(highPriceLowShareVolume, 13_000_000)
assert.equal(highPriceReceipt.passed, true, 'low share volume must pass when executable median traded value is sufficient')
assert.equal(highPriceReceipt.median_daily_traded_value_twd, 20_000_000)
assert.equal(highPriceReceipt.observed_sessions, 20)

const spikeDominated = [
  ...Array.from({ length: 11 }, () => ({ close: 10, Trading_Volume: 100_000 })),
  ...Array.from({ length: 9 }, () => ({ close: 100, Trading_Volume: 1_000_000 })),
]
const spikeReceipt = evaluateL05LiquidityCapacity(spikeDominated, 13_000_000)
assert.equal(spikeReceipt.passed, false, 'a few turnover spikes must not make a persistently thin stock pass')
assert.equal(spikeReceipt.median_daily_traded_value_twd, 1_000_000)
assert.equal(spikeReceipt.reason_code, 'median_daily_traded_value_below_min')

const exactBoundary = [
  ...Array.from({ length: 10 }, () => ({ close: 10, Trading_Volume: 1_000_000 })),
  ...Array.from({ length: 10 }, () => ({ close: 16, Trading_Volume: 1_000_000 })),
]
assert.equal(
  evaluateL05LiquidityCapacity(exactBoundary, 13_000_000).passed,
  true,
  'the even-sample median boundary must be inclusive',
)
assert.equal(
  evaluateL05LiquidityCapacity(exactBoundary.slice(0, 2), 13_000_000).reason_code,
  'l05_liquidity_observations_insufficient',
)

const screenerSource = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
assert.match(screenerSource, /evaluateL05LiquidityCapacity\(prices, sc\.minDailyTurnover\)/)
assert.match(screenerSource, /l05LiquidityCapacityPolicy/)
assert.doesNotMatch(screenerSource, /avgVol20 < sc\.minAvgVolume/)
assert.doesNotMatch(screenerSource, /reasonCode: 'avg_volume_below_min'/)

const optunaMergeSource = readFileSync(new URL('./optunaConfigMerge.ts', import.meta.url), 'utf8')
assert.doesNotMatch(optunaMergeSource, /params\.minAvgVolume/)
assert.doesNotMatch(optunaMergeSource, /params\.minDailyTurnover/)
assert.equal(DEFAULT_TRADING_CONFIG.screener.minDailyTurnover, 13_000_000)

console.log('L0.5 median daily traded value policy tests passed')
