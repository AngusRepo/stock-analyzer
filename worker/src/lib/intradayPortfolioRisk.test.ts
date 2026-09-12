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

const smallUncertainty = evaluateIntradayDrawdown({ tradeDate: '2026-09-04', currentNav: 1_000_000,
  currentNavUpperBound: 1_000_500, previous: null, haltThreshold: .05 })
assert.equal(smallUncertainty.triggered, false, 'A small uncertain right must not globally halt buying')
const materialUncertainty = evaluateIntradayDrawdown({ tradeDate: '2026-09-04', currentNav: 1_000_000,
  currentNavUpperBound: 1_060_000, previous: null, haltThreshold: .05 })
assert.equal(materialUncertainty.triggered, true, 'Uncertain exposure must not bypass drawdown safety')
assert.throws(() => evaluateIntradayDrawdown({ tradeDate: '2026-09-04', currentNav: 1_000_000,
  currentNavUpperBound: 990_000, previous: null, haltThreshold: .05 }), /bound_invalid/)

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
