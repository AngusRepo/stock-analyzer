import { strict as assert } from 'node:assert'
import { resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { matchPaperOrderAgainstAuthoritativeDepth } from './paperOrderBookMatcher'

const now = Date.parse('2026-07-13T01:04:00.500Z')
const buy = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 64,
  lotType: 'board_lot',
  nowMs: now,
  observations: [{
    source: 'shioaji_hub', lotType: 'board_lot', bid: 63.5, ask: 63.6,
    bidPrices: [63.5, 63.4], askPrices: [63.6, 63.7], bidVolumes: [3, 5], askVolumes: [1, 2],
    volumeUnit: 'lots', sourceTime: '2026-07-13T01:04:00.000Z', sessionEpoch: 8,
  }],
})
assert.equal(buy.status, 'ready')
assert.equal(buy.schemaVersion, 'authoritative_execution_snapshot_v2')
assert.equal(buy.sessionEpoch, 8)
const partial = matchPaperOrderAgainstAuthoritativeDepth({ snapshot: buy, requestedShares: 4000, limitPrice: 64 })
assert.equal(partial.status, 'partial')
assert.equal(partial.filledShares, 3000)
assert.equal(partial.restingShares, 1000)
assert.equal(Number(partial.averageFillPrice?.toFixed(4)), 63.6667)
assert(partial.levels.every((level) => level.price >= 63.6), 'BUY cannot fill below the selected fresh ask')

const sell = resolveAuthoritativeSellExecutionSnapshot({
  limitPrice: 63.4,
  lotType: 'odd_lot',
  nowMs: now,
  observations: [{
    source: 'shioaji_hub', lotType: 'odd_lot', bid: 63.5, ask: 63.6,
    bidPrices: [63.5, 63.4], askPrices: [63.6], bidVolumes: [200, 400], askVolumes: [300],
    volumeUnit: 'shares', sourceTime: '2026-07-13T01:04:00.000Z',
  }],
})
const filled = matchPaperOrderAgainstAuthoritativeDepth({ snapshot: sell, requestedShares: 500, limitPrice: 63.4 })
assert.equal(filled.status, 'filled')
assert.equal(filled.filledShares, 500)
assert(Number(filled.averageFillPrice) <= 63.5 && Number(filled.averageFillPrice) >= 63.4)

console.log('paperOrderBookMatcher tests passed')
