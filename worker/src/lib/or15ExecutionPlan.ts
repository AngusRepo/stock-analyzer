import { getTwTickSize, normalizeTwLimitPrice, snapToTwPriceTick } from './twMarketRules'

export interface Or15ExecutionPlan {
  owner: 'or15_ohlcv_v2'
  action: 'pass' | 'defer'
  reason: string
  signalMs: number
  entry: number
  stop: number
  tp1: number
  tp2: number
  maxBuyPrice: number
  tp1Source: 'initial_risk_1_5R' | 'ohlcv_resistance'
  tp2Source: 'initial_risk_3R'
}

/** Build once after a closed-bar signal. Selection prices remain audit references. */
export function buildOr15ExecutionPlan(input: {
  signalMs: number; entry: number; orHigh: number; orLow: number; vwap: number;
  support?: number | null; resistance?: number | null; atr: number; maxChasePct: number;
}): Or15ExecutionPlan {
  const plan: Or15ExecutionPlan = { owner: 'or15_ohlcv_v2', action: 'defer', reason: 'or15_invalid_execution_plan',
    signalMs: input.signalMs, entry: input.entry, stop: 0, tp1: 0, tp2: 0, maxBuyPrice: 0,
    tp1Source: 'initial_risk_1_5R', tp2Source: 'initial_risk_3R' }
  if (![input.signalMs, input.entry, input.orHigh, input.orLow, input.vwap, input.atr, input.maxChasePct].every(Number.isFinite)
    || input.signalMs <= 0 || input.orLow <= 0 || input.orHigh < input.orLow || input.vwap <= 0
    || input.atr <= 0 || input.maxChasePct < 0 || input.maxChasePct > .03) return plan
  // Preserve the existing chase allowance, anchored to today's breakout level.
  plan.maxBuyPrice = normalizeTwLimitPrice(input.orHigh * (1 + input.maxChasePct), 'buy')
  if (input.entry <= Math.max(input.orHigh, input.vwap)) return { ...plan, reason: 'or15_quote_below_breakout_or_vwap' }
  if (input.entry > plan.maxBuyPrice) return { ...plan, reason: 'or15_above_structure_max_buy' }
  const support = Number.isFinite(input.support) && input.support! > 0 && input.support! < input.entry
    ? input.support! : 0
  const floor = Math.max(input.orLow, support)
  plan.stop = snapToTwPriceTick(floor - Math.max(getTwTickSize(floor), .25 * input.atr), 'floor')
  if (plan.stop <= 0 || plan.stop >= input.entry) return { ...plan, reason: 'or15_invalid_structural_stop' }
  const risk = input.entry - plan.stop
  const pressure = Number.isFinite(input.resistance) && input.resistance! > input.entry ? input.resistance! : Infinity
  const first = input.entry + 1.5 * risk
  // Pressure caps achievable reward; it is never pushed away to manufacture RR.
  plan.tp1 = snapToTwPriceTick(Math.min(first, pressure), pressure < first ? 'floor' : 'ceil')
  plan.tp2 = snapToTwPriceTick(input.entry + 3 * risk, 'ceil')
  plan.tp1Source = pressure < first ? 'ohlcv_resistance' : 'initial_risk_1_5R'
  if (plan.tp1 <= input.entry || plan.tp2 <= plan.tp1) return { ...plan, reason: 'or15_no_ordered_targets' }
  // These are lifecycle targets, not today's submitted sell orders: no daily-band clipping.
  return { ...plan, action: 'pass', reason: 'or15_unified_execution_plan' }
}

/** Fixed targets imply an upper entry cost for net TP1>=1R and TP2>=2R. */
export function capOr15PlanByCosts(plan: Or15ExecutionPlan, costs: {
  buyCost: (entry: number) => number; netProceeds: (price: number) => number;
}): Or15ExecutionPlan {
  if (plan.action !== 'pass') return plan
  const stopValue = costs.netProceeds(plan.stop)
  const maxCost = Math.min((costs.netProceeds(plan.tp1) + stopValue) / 2,
    (costs.netProceeds(plan.tp2) + 2 * stopValue) / 3)
  if (!Number.isFinite(maxCost) || maxCost <= 0) return { ...plan, action: 'defer', reason: 'or15_invalid_cost_plan' }
  let low = 0, high = plan.maxBuyPrice
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2
    if (costs.buyCost(mid) <= maxCost) low = mid
    else high = mid
  }
  let ceiling = normalizeTwLimitPrice(low, 'buy')
  // Tick helper rounds fractional cents first; recheck costs after snapping.
  while (ceiling > 0 && costs.buyCost(ceiling) > maxCost) {
    ceiling = normalizeTwLimitPrice(ceiling - getTwTickSize(ceiling), 'buy')
  }
  return { ...plan, maxBuyPrice: Math.min(plan.maxBuyPrice, ceiling),
    action: plan.entry <= ceiling ? 'pass' : 'defer',
    reason: plan.entry <= ceiling ? 'or15_unified_execution_plan' : 'or15_insufficient_net_reward_risk' }
}
