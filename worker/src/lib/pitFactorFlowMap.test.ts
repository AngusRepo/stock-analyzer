import assert from 'node:assert/strict'
import {
  buildPitFactorGroupSeries,
  selectPitFactorStockSymbols,
  type PitFactorFunnelPoint,
} from './pitFactorFlowMap'

function point(overrides: Partial<PitFactorFunnelPoint>): PitFactorFunnelPoint {
  return {
    date: '2026-08-28',
    symbol: 'A',
    name: 'A',
    industry: '電子',
    rankDelta: 0,
    candidateCount: 5,
    residualRank: 0.5,
    breadthRank: 0.6,
    flowRank: 0.8,
    confirmationRank: 0.7,
    ...overrides,
  }
}

const groups = buildPitFactorGroupSeries([
  point({ symbol: 'A', rankDelta: 2, residualRank: 0.1 }),
  point({ symbol: 'B', rankDelta: 0, residualRank: 0.9 }),
  point({ date: '2026-08-29', symbol: 'A', rankDelta: 1, residualRank: 0.2 }),
  point({ date: '2026-08-29', symbol: 'B', rankDelta: 1, residualRank: 0.8 }),
])
assert.equal(groups.length, 1)
assert.equal(groups[0].points.length, 2)
assert.equal(groups[0].points[0].x, 62.5)
assert.equal(groups[0].points[1].x, 62.5)
assert.equal(groups[0].points[0].y, 70)

const allIndustries = buildPitFactorGroupSeries(Array.from({ length: 13 }, (_value, index) => point({
  symbol: `S${index}`,
  industry: `產業${index}`,
  rankDelta: index - 6,
})))
assert.equal(allIndustries.length, 13, 'industry trajectories must not be truncated to 12')

const selected = selectPitFactorStockSymbols([
  point({ symbol: 'A', rankDelta: 1 }),
  point({ symbol: 'B', rankDelta: -4 }),
  point({ symbol: 'C', rankDelta: 3 }),
], ['PENDING'], 2)
assert.deepEqual(selected, ['PENDING', 'B', 'C'])
