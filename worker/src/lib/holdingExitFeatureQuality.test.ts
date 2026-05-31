import assert from 'node:assert/strict'
import { loadHoldingExitFeatureMap } from './holdingExitFeatureLoader'
import { buildHoldingExitReview } from './holdingExitReview'

class FakeStatement {
  private args: unknown[] = []

  constructor(private db: FakeDb, private sql: string) {}

  bind(...args: unknown[]) {
    this.args = args
    this.db.boundStatements.push({ sql: this.sql, args })
    return this
  }

  async first() {
    if (this.sql.includes('technical_indicators')) {
      return { obv_temperature_60: 31, row_count: 1, latest_date: '2026-05-30' }
    }
    if (this.sql.includes('canonical_chip_daily')) {
      return { institutional_net_5d: -12_000_000, row_count: 5, latest_date: '2026-05-30' }
    }
    if (this.sql.includes('canonical_broker_flow_daily')) {
      return {
        broker_net_amount_5d: -18_000_000,
        broker_concentration_delta_5d: -0.16,
        row_count: 5,
        latest_date: '2026-05-30',
      }
    }
    if (this.sql.includes('stock_prices')) {
      return { max_high: 121, support_low: 101, row_count: 20, latest_date: '2026-05-30' }
    }
    throw new Error(`unexpected SQL: ${this.sql}`)
  }
}

class FakeDb {
  boundStatements: Array<{ sql: string; args: unknown[] }> = []

  prepare(sql: string) {
    return new FakeStatement(this, sql)
  }
}

async function runFeatureLoaderQualityContract() {
  const db = new FakeDb()
  const features = await loadHoldingExitFeatureMap(
    db as any,
    [{ symbol: '2408', avg_cost: 100, entry_price: 100, entry_date: '2026-05-01' }],
    new Map([['2408', 112]]),
    '2026-05-31',
    'sideways',
  )

  const row = features.get('2408')
  assert(row, 'feature loader should return one feature row')
  assert.equal(row.featureQuality?.coverage, 1, 'complete broker/chip/money/price/regime data should have full coverage')
  assert.deepEqual(row.featureQuality?.missing, [], 'complete data should not report missing factor groups')
  assert.equal(row.featureQuality?.sources.brokerFlow.rows, 5, 'broker-flow source should expose loaded row count')
  assert.equal(row.featureQuality?.sources.priceWindow.latestDate, '2026-05-30', 'price-window source should expose latest date')
  assert(
    db.boundStatements.some((stmt) => stmt.sql.includes('canonical_chip_daily') && stmt.sql.includes('JOIN stocks')),
    'chip feature query must resolve canonical stock_id through stocks.symbol, not bind symbol into stock_id',
  )
  assert(
    db.boundStatements.some((stmt) => stmt.sql.includes('canonical_broker_flow_daily') && stmt.sql.includes('JOIN stocks')),
    'broker-flow feature query must resolve canonical stock_id through stocks.symbol, not bind symbol into stock_id',
  )
}

function runReviewMissingFeatureContract() {
  const review = buildHoldingExitReview({
    position: {
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
    },
    currentPrice: 112,
    atr14: 3,
    baseline: { action: 'hold', reason: 'no trigger' },
    features: {
      supportBreakPct: 0,
      mfePct: 0.18,
      givebackPct: 0.06,
      regime: 'volatile',
    },
  })

  assert(review.confidence < 1, 'missing broker/chip/money-flow sources should reduce review confidence')
  assert(
    review.reasons.some((reason) => reason.includes('feature_quality_missing')),
    'review reasons should expose missing factor groups instead of silently scoring them as zero',
  )
  assert(review.features.featureQuality?.missing.includes('brokerFlow'), 'review should carry normalized feature quality')
}

runFeatureLoaderQualityContract()
  .then(runReviewMissingFeatureContract)
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
