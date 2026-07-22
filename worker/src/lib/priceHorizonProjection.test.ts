import assert from 'node:assert/strict'
import { buildPriceHorizonObservations } from './priceHorizonProjection'

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
