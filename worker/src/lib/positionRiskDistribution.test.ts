import assert from 'node:assert/strict'
import { assessPositionCorrelation, type PositionPriceRow } from './positionRiskDistribution'

function series(symbol: string, changes: number[]): PositionPriceRow[] {
  let close = 100
  return changes.map((change, index) => {
    close *= 1 + change
    return { symbol, date: `2026-07-${String(index + 1).padStart(2, '0')}`, close }
  })
}

const base = Array.from({ length: 25 }, (_, index) => (
  index % 4 === 0 ? 0.02 : index % 3 === 0 ? -0.01 : 0.004
))
const blocked = assessPositionCorrelation({
  candidateSymbol: 'AAA',
  holdingSymbols: ['BBB'],
  priceRows: [...series('AAA', base), ...series('BBB', base.map((value) => value * 0.95))],
  threshold: 0.7,
  minimumOverlappingReturns: 20,
})
assert.equal(blocked.status, 'blocked')
assert.equal(blocked.max_correlation_peer, 'BBB')
assert((blocked.max_positive_correlation ?? 0) >= 0.99)

const diversified = assessPositionCorrelation({
  candidateSymbol: 'AAA',
  holdingSymbols: ['CCC'],
  priceRows: [...series('AAA', base), ...series('CCC', base.map((value) => -value))],
  threshold: 0.7,
  minimumOverlappingReturns: 20,
})
assert.equal(diversified.status, 'pass')
assert((diversified.max_positive_correlation ?? 1) < 0)

const sparse = assessPositionCorrelation({
  candidateSymbol: 'AAA',
  holdingSymbols: ['NEW'],
  priceRows: [...series('AAA', base), ...series('NEW', [0.01, -0.01, 0.02])],
  threshold: 0.7,
  minimumOverlappingReturns: 20,
})
assert.equal(sparse.status, 'fallback_insufficient_data')

console.log('position risk distribution tests passed')
