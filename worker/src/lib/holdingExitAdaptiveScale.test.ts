import assert from 'node:assert/strict'
import { loadHoldingExitFeatureMap } from './holdingExitFeatureLoader'
import { buildHoldingExitReview } from './holdingExitReview'

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
  const defaultScaleReview = buildHoldingExitReview({
    position: basePosition,
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: -5_000_000,
      brokerConcentrationDelta5d: 0,
      institutionalNetAmount5d: 0,
      obvTemperature60: 68,
      supportBreakPct: 0,
      mfePct: 0.18,
      givebackPct: 0.01,
      regime: 'sideways',
    },
  })

  const adaptiveScaleReview = buildHoldingExitReview({
    position: basePosition,
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: -5_000_000,
      brokerConcentrationDelta5d: 0,
      institutionalNetAmount5d: 0,
      obvTemperature60: 68,
      supportBreakPct: 0,
      mfePct: 0.18,
      givebackPct: 0.01,
      regime: 'sideways',
      factorScale: {
        brokerNetAmount5d: 5_000_000,
        institutionalNetAmount5d: 8_000_000,
        provenance: {
          source: 'holding_exit_feature_loader',
          method: 'rolling_abs_sell_average',
          lookbackRows: 60,
        },
      },
    },
  })

  assert(defaultScaleReview.factors.brokerFlow < 0.35, 'fixed fallback scale should not overstate small broker sell flow')
  assert.equal(adaptiveScaleReview.factors.brokerFlow, 1, 'adaptive broker sell scale should normalize stock-specific distribution pressure')
  assert(
    adaptiveScaleReview.reasons.includes('broker_flow_distribution'),
    'adaptive broker scale should preserve readable distribution reason',
  )
  assert.equal(
    adaptiveScaleReview.features.factorScale?.provenance.method,
    'rolling_abs_sell_average',
    'review should preserve factor-scale provenance for auditability',
  )
}

{
  const defaultScaleReview = buildHoldingExitReview({
    position: basePosition,
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: 0,
      brokerConcentrationDelta5d: 0,
      institutionalNetAmount5d: 0,
      obvTemperature60: 39,
      supportBreakPct: 0.01,
      mfePct: 0.20,
      givebackPct: 0.04,
      regime: 'sideways',
    },
  })

  const adaptiveScaleReview = buildHoldingExitReview({
    position: basePosition,
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      brokerNetAmount5d: 0,
      brokerConcentrationDelta5d: 0,
      institutionalNetAmount5d: 0,
      obvTemperature60: 39,
      supportBreakPct: 0.01,
      mfePct: 0.20,
      givebackPct: 0.04,
      regime: 'sideways',
      factorScale: {
        moneyFlowWeakThreshold: 80,
        supportBreakPct: 0.01,
        givebackRatio: 0.20,
        provenance: {
          source: 'holding_exit_feature_loader',
          method: 'rolling_technical_price_scale',
          lookbackRows: 60,
        },
      },
    },
  })

  assert(defaultScaleReview.factors.moneyFlow < 0.35, 'fixed OBV threshold should not overstate mildly weak money flow')
  assert(defaultScaleReview.factors.structure < 0.35, 'fixed support-break scale should not overstate shallow support breaks')
  assert(defaultScaleReview.factors.giveback < 0.30, 'fixed giveback ratio should not overstate normal giveback')
  assert(adaptiveScaleReview.factors.moneyFlow >= 0.5, 'adaptive OBV threshold should normalize stock-specific weak money flow')
  assert.equal(adaptiveScaleReview.factors.structure, 1, 'adaptive support-break scale should normalize stock-specific structure break')
  assert(adaptiveScaleReview.factors.giveback >= 0.99, 'adaptive giveback scale should normalize stock-specific profit giveback')
  assert(adaptiveScaleReview.reasons.includes('money_flow_weakness'), 'adaptive money-flow scale should preserve reason')
  assert(adaptiveScaleReview.reasons.includes('structure_break'), 'adaptive support-break scale should preserve reason')
  assert(adaptiveScaleReview.reasons.includes('giveback_risk'), 'adaptive giveback scale should preserve reason')
}

class FakeStatement {
  constructor(private sql: string) {}

  bind(..._args: unknown[]) {
    return this
  }

  async first() {
    if (this.sql.includes('technical_indicators')) {
      return {
        obv_temperature_60: 31,
        obv_weak_threshold: 64,
        row_count: 60,
        latest_date: '2026-05-30',
      }
    }
    if (this.sql.includes('canonical_chip_daily')) {
      return {
        institutional_net_5d: -6_000_000,
        institutional_sell_scale: 3_000_000,
        row_count: 5,
        latest_date: '2026-05-30',
      }
    }
    if (this.sql.includes('canonical_broker_flow_daily')) {
      return {
        broker_net_amount_5d: -4_500_000,
        broker_concentration_delta_5d: -0.16,
        broker_sell_scale: 2_250_000,
        row_count: 5,
        latest_date: '2026-05-30',
      }
    }
    if (this.sql.includes('stock_prices')) {
      return {
        max_high: 121,
        support_low: 101,
        support_break_scale: 0.024,
        giveback_ratio_scale: 0.22,
        row_count: 20,
        latest_date: '2026-05-30',
      }
    }
    throw new Error(`unexpected SQL: ${this.sql}`)
  }
}

class FakeDb {
  prepare(sql: string) {
    return new FakeStatement(sql)
  }
}

async function runLoaderScaleContract() {
  const features = await loadHoldingExitFeatureMap(
    new FakeDb() as any,
    [{ symbol: '2408', avg_cost: 100, entry_price: 100, entry_date: '2026-05-01' }],
    new Map([['2408', 112]]),
    '2026-05-31',
    'sideways',
  )

  const row = features.get('2408')
  assert(row, 'feature loader should return one feature row')
  assert.equal(row.factorScale?.brokerNetAmount5d, 2_250_000, 'loader should expose rolling broker sell scale')
  assert.equal(row.factorScale?.institutionalNetAmount5d, 3_000_000, 'loader should expose rolling institutional sell scale')
  assert.equal(row.factorScale?.moneyFlowWeakThreshold, 64, 'loader should expose rolling OBV weak threshold')
  assert.equal(row.factorScale?.supportBreakPct, 0.024, 'loader should expose rolling support-break scale')
  assert.equal(row.factorScale?.givebackRatio, 0.22, 'loader should expose rolling giveback ratio scale')
  assert.equal(row.factorScale?.provenance.lookbackRows, 60, 'loader should expose factor-scale lookback')
}

runLoaderScaleContract().catch((error) => {
  console.error(error)
  process.exit(1)
})
