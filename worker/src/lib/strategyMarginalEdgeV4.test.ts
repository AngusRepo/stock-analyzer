import assert from 'node:assert/strict'
import {
  evaluatePairedStrategyReplacementsV6,
  evaluateStrategyMarginalEdgesV4,
  evaluateStrategyPortfolioEdgeV4,
  type OutcomeCell,
} from './strategyMarginalEdgeV4'

const cells: OutcomeCell[] = []
for (let day = 1; day <= 12; day++) {
  const date = `2026-07-${String(day).padStart(2, '0')}`
  const goodResidual = 0.012 + (day % 3) * 0.002
  const badResidual = -0.012 + (day % 2) * 0.003
  for (const strategy of ['A', 'B']) {
    cells.push({
      signal_date: date,
      symbol: 'GOOD',
      strategy_id: strategy,
      strategy_version: 'v1',
      family_id: 'TREND_RECLAIM_CONTINUATION',
      production_owner: strategy === 'B' ? 1 : 0,
      strategy_hit: strategy === 'A' ? 1 : 0,
      absolute_return_net: goodResidual + 0.003,
      residual_return_net: goodResidual,
    })
    cells.push({
      signal_date: date,
      symbol: 'BAD',
      strategy_id: strategy,
      strategy_version: 'v1',
      family_id: 'TREND_RECLAIM_CONTINUATION',
      production_owner: strategy === 'B' ? 1 : 0,
      strategy_hit: strategy === 'B' ? 1 : 0,
      absolute_return_net: badResidual - 0.002,
      residual_return_net: badResidual,
    })
  }
}

const result = evaluateStrategyMarginalEdgesV4(cells)
const good = result.find((row) => row.strategyId === 'A')!
const bad = result.find((row) => row.strategyId === 'B')!
assert.equal(good.observationDates, 12)
assert.equal(good.productionEligible, true, 'candidate strategy needs at least ten OOS dates and positive cost-net edge')
assert(good.marginalEdgeMean! > 0)
assert(good.marginalEdgeLcb90! > 0)
assert.equal(bad.productionEligible, false)
assert(bad.marginalEdgeMean! < 0)
assert.equal(bad.productionWeightRaw, 0)

const portfolio = evaluateStrategyPortfolioEdgeV4(cells, new Map([['A|v1', 1]]))
assert.equal(portfolio.length, 12)
assert(portfolio.every((row) => row.residualReturn > 0 && row.absoluteReturn > 0))

const replacement = evaluatePairedStrategyReplacementsV6(
  cells,
  result,
  new Map([['B|v1', 1]]),
)
assert.equal(replacement.accepted.length, 1, 'positive same-family paired evidence should replace one weak active')
assert.equal(replacement.accepted[0].candidateKey, 'A|v1')
assert.equal(replacement.accepted[0].incumbentKey, 'B|v1')
assert.equal(replacement.finalWeights.size, 1, 'one-in-one-out cutover must keep production strategy count stable')
assert(replacement.finalWeights.has('A|v1'))
assert(!replacement.finalWeights.has('B|v1'))
assert(replacement.globalPaired.lcb90! > 0)
assert(replacement.globalRiskPass)

const crossFamilyCells = cells
  .filter((row) => row.strategy_id !== 'A')
  .concat(cells.filter((row) => row.strategy_id === 'A').map((row) => ({
    ...row,
    strategy_id: 'C',
    family_id: 'REVENUE_QUALITY_MOMENTUM',
  })))
const crossFamilyEdges = evaluateStrategyMarginalEdgesV4(crossFamilyCells)
const crossFamilyReplacement = evaluatePairedStrategyReplacementsV6(
  crossFamilyCells,
  crossFamilyEdges,
  new Map([['B|v1', 1]]),
)
assert.equal(crossFamilyReplacement.accepted.length, 1, 'cross-family replacement should pass only through paired portfolio gates')
assert.equal(crossFamilyReplacement.accepted[0].candidateKey, 'C|v1')
assert.equal(crossFamilyReplacement.accepted[0].replacementScope, 'cross_family')
assert.equal(crossFamilyReplacement.accepted[0].incumbentFamilyId, 'TREND_RECLAIM_CONTINUATION')
assert.equal(crossFamilyReplacement.globalCorrelationPass, true)
assert.equal(crossFamilyReplacement.globalTurnoverPass, true)
assert.equal(crossFamilyReplacement.globalRiskPass, true)

const insufficient = evaluateStrategyMarginalEdgesV4(cells.filter((row) => row.signal_date <= '2026-07-05'))
assert.equal(
  insufficient.find((row) => row.strategyId === 'A')?.productionEligible,
  false,
  'five dates must not pass the unified ten-date production gate',
)

console.log('strategyMarginalEdgeV4 tests passed')
