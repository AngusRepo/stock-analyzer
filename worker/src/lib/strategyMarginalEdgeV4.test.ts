import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateStrategyMarginalEdgesV4, evaluateStrategyPortfolioEdgeV4 } from './strategyMarginalEdgeV4'

const cells: any[] = []
for (let day = 1; day <= 5; day++) {
  const date = `2026-07-0${day}`
  for (const strategy of ['A', 'B']) {
    cells.push({
      signal_date: date,
      symbol: 'GOOD',
      strategy_id: strategy,
      strategy_version: 'v1',
      production_owner: strategy === 'A' ? 0 : 1,
      strategy_hit: strategy === 'A' ? 1 : 0,
      absolute_return_net: 0.03,
      residual_return_net: 0.02,
    })
    cells.push({
      signal_date: date,
      symbol: 'BAD',
      strategy_id: strategy,
      strategy_version: 'v1',
      production_owner: 1,
      strategy_hit: strategy === 'B' ? 1 : 0,
      absolute_return_net: -0.005,
      residual_return_net: -0.01,
    })
  }
}

const result = evaluateStrategyMarginalEdgesV4(cells)
const good = result.find((row) => row.strategyId === 'A')!
const bad = result.find((row) => row.strategyId === 'B')!
assert.equal(good.observationDates, 5)
assert.equal(good.productionEligible, true, 'candidate/shadow strategy with real OOS edge must be eligible for promotion')
assert(good.marginalEdgeMean! > 0)
assert(good.marginalEdgeLcb90! > 0)
assert.equal(bad.productionEligible, false)
assert(bad.marginalEdgeMean! < 0)
assert.equal(bad.productionWeightRaw, 0)

const portfolio = evaluateStrategyPortfolioEdgeV4(cells, new Map([['A|v1', 1]]))
assert.equal(portfolio.length, 5)
assert(portfolio.every((row) => row.residualReturn === 0.02 && row.absoluteReturn === 0.03))

const source = readFileSync(new URL('./strategyMarginalEdgeV4.ts', import.meta.url), 'utf8')
assert.match(source, /SET status='candidate', promotion_status='candidate'/)
assert.match(source, /NOT IN \(\$\{eligibleRegistryKeys\.map/)
assert.match(source, /atomic_registry_replacement: true/)

console.log('strategyMarginalEdgeV4 tests passed')
