import assert from 'node:assert/strict'
import { buildPortfolioDeRiskPlan } from './portfolioDeRisk'

const plan = buildPortfolioDeRiskPlan({
  totalPortfolio: 1_000_000,
  targetExposure: 0.45,
  holdings: [
    { symbol: 'STRONG', shares: 2000, price: 100, weakness: 5 },
    { symbol: 'WEAK', shares: 2000, price: 100, weakness: 80 },
    { symbol: 'MID', shares: 2000, price: 100, weakness: 30 },
    { symbol: 'OTHER', shares: 2000, price: 100, weakness: 10 },
  ],
})

assert.equal(plan.currentExposure, 0.8)
assert.equal(plan.required, true)
assert.deepEqual(plan.fullExitSymbols, ['WEAK', 'MID'])
assert(plan.projectedPositionsValue <= plan.targetPositionsValue)

const noChurn = buildPortfolioDeRiskPlan({
  totalPortfolio: 1_000_000,
  targetExposure: 0.68,
  holdings: [
    { symbol: 'A', shares: 3000, price: 100, weakness: 10 },
    { symbol: 'B', shares: 3000, price: 100, weakness: 20 },
  ],
})
assert.equal(noChurn.required, false)
assert.deepEqual(noChurn.fullExitSymbols, [])
