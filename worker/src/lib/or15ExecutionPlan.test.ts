import assert from 'node:assert/strict'
import { buildOr15ExecutionPlan, capOr15PlanByCosts } from './or15ExecutionPlan'
import { assessOr15PaperPrice, assessOr15NetRewardRisk } from './or15PaperPricePolicy'
import { getTwTickSize, snapToTwPriceTick } from './twMarketRules'

const input = { signalMs: 1, entry: 46.5, orHigh: 46, orLow: 43.7, vwap: 45.2,
  support: 30.7, resistance: 45, atr: 2.1, maxChasePct: .018 }
const plan = buildOr15ExecutionPlan(input)
assert.equal(plan.action, 'pass')
assert.equal(plan.stop, 43.15)
assert.equal(plan.tp1, 51.6)
assert.equal(plan.tp2, 56.6)
assert.equal(plan.maxBuyPrice, 46.8)
assert(plan.tp1 > 48.2 && plan.tp2 > plan.tp1, 'cross-day targets must not collapse at today limit-up')
assert.equal(assessOr15PaperPrice({ referenceEntry: 43.5, proposedBuy: input.entry,
  structuralStop: plan.stop, modelTp1: 63.6, modelTp2: 83.6, maxChasePct: .018 }).action, 'defer')
assert.equal(buildOr15ExecutionPlan({ ...input, entry: 50 }).reason, 'or15_above_structure_max_buy')
assert.equal(buildOr15ExecutionPlan({ ...input, entry: 46 }).reason, 'or15_quote_below_breakout_or_vwap')
assert.equal(buildOr15ExecutionPlan({ ...input, atr: NaN }).action, 'defer')
assert.equal(buildOr15ExecutionPlan({ ...input, signalMs: 0 }).action, 'defer')
const costs = {
  buyCost: (p: number) => p * 1000 + Math.max(20, p * 1000 * .001425 * .25),
  netProceeds: (p: number) => {
    const value = snapToTwPriceTick(p - getTwTickSize(p), 'floor') * 1000
    return value - Math.max(20, value * .001425 * .25) - value * .003
  },
}
const verified = capOr15PlanByCosts(plan, costs)
assert.equal(verified.action, 'pass')
assert.equal(verified.stop, plan.stop)
assert.equal(verified.tp1, plan.tp1)
assert.equal(verified.tp2, plan.tp2)
assert(verified.maxBuyPrice <= plan.maxBuyPrice)
const rr = assessOr15NetRewardRisk({ entry: plan.entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
  buyCost: costs.buyCost(plan.entry), netProceeds: costs.netProceeds })
assert(rr.pass)
const pressure = buildOr15ExecutionPlan({ ...input, resistance: 47 })
assert.equal(pressure.tp1, 47, 'near pressure cannot be stretched away to pass RR')
assert.equal(capOr15PlanByCosts(pressure, costs).action, 'defer')
const betterFill = capOr15PlanByCosts({ ...plan, entry: 46.45 }, costs)
assert.equal(betterFill.tp1, plan.tp1, 'fill improvement preserves the same targets')
assert.equal(betterFill.stop, plan.stop)
const s6217 = buildOr15ExecutionPlan({ ...input, entry: 180, orHigh: 178, orLow: 174,
  vwap: 177.38, support: 150, resistance: 175, atr: 6, maxChasePct: .01 })
assert.equal(s6217.reason, 'or15_above_structure_max_buy')
assert.equal(s6217.maxBuyPrice, 179.5, 'retain chase protection even though old 171 ceiling is removed')
console.log('Unified OR15 execution plan PASS', JSON.stringify({ plan, verified, rr, s6217 }))
