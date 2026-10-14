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
assert.deepEqual(plan.fullExitSymbols, ['WEAK'])
assert.deepEqual(plan.reductions, {WEAK:2000,MID:1500})
assert.equal(plan.projectedPositionsValue,450000)
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

const one = buildPortfolioDeRiskPlan({totalPortfolio:1e6,targetExposure:.2,
  holdings:[{symbol:'2327',shares:2500,price:100,weakness:1}]})
assert.deepEqual(one.reductions,{'2327':500})
assert.equal(one.projectedPositionsValue,200000)
const black = buildPortfolioDeRiskPlan({totalPortfolio:1e6,targetExposure:0,
  holdings:[{symbol:'2327',shares:193,price:627,weakness:1}]})
assert.deepEqual(black.reductions,{'2327':193})
assert.deepEqual(black.fullExitSymbols,['2327'])
const rounded = buildPortfolioDeRiskPlan({totalPortfolio:962772.63,targetExposure:.08,
  holdings:[{symbol:'2327',shares:193,price:627,weakness:1}]})
assert.deepEqual(rounded.reductions,{'2327':71})
assert(rounded.targetPositionsValue-rounded.projectedPositionsValue<627)
