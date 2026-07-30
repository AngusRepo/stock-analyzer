import assert from 'node:assert/strict'
import { PRICE_HORIZON_PROJECTION_VERSION, planPriceHorizonWork } from './priceHorizonProjection'

const horizon = {
  signal_date: '2026-07-22',
  entry_date: '2026-07-23',
  exit_date: '2026-07-29',
}
const plan = planPriceHorizonWork(
  [horizon],
  [{
    ...horizon,
    status: 'empty',
    projection_version: PRICE_HORIZON_PROJECTION_VERSION,
    updated_at: '2026-07-29 13:00:00',
  }],
  { maxProcessDates: 1, nowMs: Date.parse('2026-07-30T00:00:00Z') },
)

assert.equal(plan.skippedCompleteDates, 0)
assert.deepEqual(plan.work, [horizon])
