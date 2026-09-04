import assert from 'node:assert/strict'
import { evaluateIntradayDrawdown } from './intradayPortfolioRisk'

const first = evaluateIntradayDrawdown({
  tradeDate: '2026-09-04',
  currentNav: 1_000_000,
  previous: null,
  haltThreshold: 0.05,
  nowIso: '2026-09-04T01:00:00Z',
})
assert.equal(first.triggered, false)
assert.equal(first.state.peakNav, 1_000_000)

const newHigh = evaluateIntradayDrawdown({
  tradeDate: '2026-09-04',
  currentNav: 1_020_000,
  previous: first.state,
  haltThreshold: 0.05,
  nowIso: '2026-09-04T02:00:00Z',
})
assert.equal(newHigh.state.peakNav, 1_020_000)
assert.equal(newHigh.triggered, false)

const stopped = evaluateIntradayDrawdown({
  tradeDate: '2026-09-04',
  currentNav: 960_000,
  previous: newHigh.state,
  haltThreshold: 0.05,
  nowIso: '2026-09-04T03:00:00Z',
})
assert.equal(stopped.triggered, true)
assert(stopped.drawdown > 0.058 && stopped.drawdown < 0.059)

const recovered = evaluateIntradayDrawdown({
  tradeDate: '2026-09-04',
  currentNav: 1_010_000,
  previous: stopped.state,
  haltThreshold: 0.05,
  nowIso: '2026-09-04T04:00:00Z',
})
assert.equal(recovered.triggered, true, 'P9 halt must remain latched for the rest of the trade date')
assert.equal(recovered.state.halted, true)

const nextDay = evaluateIntradayDrawdown({
  tradeDate: '2026-09-05',
  currentNav: 1_010_000,
  previous: recovered.state,
  haltThreshold: 0.05,
  nowIso: '2026-09-05T01:00:00Z',
})
assert.equal(nextDay.triggered, false, 'P9 latch must reset on a new trade date')
