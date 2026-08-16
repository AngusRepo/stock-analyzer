import assert from 'node:assert/strict'
import {
  PRICE_HORIZON_PROJECTION_VERSION,
  STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
  buildPriceHorizonObservations,
  planPriceHorizonWork,
} from './priceHorizonProjection'

const result = buildPriceHorizonObservations(
  [3, 1, 2, 1],
  '2026-07-01',
  '2026-07-02',
  '2026-07-08',
  [
    { stock_id: 1, open: 100, close: 101, adj_close: 202 },
    { stock_id: 2, open: null, close: 50, adj_close: 50 },
    { stock_id: 3, open: 30, close: 30, adj_close: 30 },
  ],
  [
    { stock_id: 1, open: 110, close: 120, adj_close: 240 },
    { stock_id: 2, open: 51, close: 55, adj_close: 55 },
  ],
)

assert.deepEqual(result.labels, [{
  stockId: 1,
  priceDate: '2026-07-01',
  entryDate: '2026-07-02',
  entryRawOpen: 100,
  entryAdjustmentFactor: 2,
  exitDate: '2026-07-08',
  exitRawClose: 120,
  exitAdjustmentFactor: 2,
}])
assert.deepEqual(result.rejections, [
  {
    stockId: 2,
    priceDate: '2026-07-01',
    entryDate: '2026-07-02',
    exitDate: '2026-07-08',
    reason: 'entry_open_invalid',
  },
  {
    stockId: 3,
    priceDate: '2026-07-01',
    entryDate: '2026-07-02',
    exitDate: '2026-07-08',
    reason: 'exit_price_row_missing',
  },
])

const factorFailure = buildPriceHorizonObservations(
  [7],
  '2026-07-01',
  '2026-07-02',
  '2026-07-08',
  [{ stock_id: 7, open: 10, close: 10, adj_close: null }],
  [{ stock_id: 7, open: 11, close: 12, adj_close: 12 }],
)
assert.equal(factorFailure.labels.length, 0)
assert.equal(factorFailure.rejections[0]?.reason, 'entry_adjustment_factor_invalid')

const horizons = Array.from({ length: 12 }, (_, index) => ({
  signal_date: `2026-06-${String(index + 1).padStart(2, '0')}`,
  entry_date: `2026-06-${String(index + 2).padStart(2, '0')}`,
  exit_date: `2026-06-${String(index + 6).padStart(2, '0')}`,
}))
const statuses = [
  {
    ...horizons[0],
    status: 'success',
    projection_version: PRICE_HORIZON_PROJECTION_VERSION,
    updated_at: '2026-07-20 00:00:00',
  },
  {
    ...horizons[1],
    status: 'incomplete',
    projection_version: PRICE_HORIZON_PROJECTION_VERSION,
    updated_at: '2026-07-20 00:00:00',
  },
]
const plan = planPriceHorizonWork(horizons, statuses, {
  maxProcessDates: 4,
  nowMs: Date.parse('2026-07-23T00:00:00Z'),
})
assert.deepEqual(
  plan.work.map((row) => row.signal_date),
  ['2026-06-12', '2026-06-11', '2026-06-03', '2026-06-04'],
)
assert.equal(plan.skippedCompleteDates, 1)
assert.equal(plan.deferredSignalDates, 7)
const independentContractPlan = planPriceHorizonWork(horizons.slice(0, 1), statuses.slice(0, 1), {
  maxProcessDates: 1,
  projectionVersion: STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
})
assert.deepEqual(
  independentContractPlan.work.map((row) => row.signal_date),
  ['2026-06-01'],
  'canonical 5d success must not suppress a distinct strategy multi-horizon projection contract',
)

const forced = planPriceHorizonWork(horizons, statuses, {
  force: true,
  maxProcessDates: 3,
  nowMs: Date.parse('2026-07-23T00:00:00Z'),
})
assert.deepEqual(
  forced.work.map((row) => row.signal_date),
  ['2026-06-12', '2026-06-11', '2026-06-01'],
)