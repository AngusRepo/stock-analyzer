import type { Bindings } from '../types'
import { readL4ExecutionPlan } from './paperDailyPlanRuntime'
import { assertL4PlanCurrentPolicy, type L4PortfolioPlan } from './l4PortfolioPlan'
import { getTradingConfig } from './tradingConfig'
import { getPrevTradingDay } from './paperMarketData'
import { databaseForDataDomain } from './dataDomainRegistry'

export type PositionL4Context = { status: 'ready'; plan: L4PortfolioPlan; tradeDate: string }
  | { status: 'unavailable'; reason: string }

/** Read the same sealed plan and policy gates as the exit executor; never writes an order. */
export async function loadPositionL4Context(env: Bindings, tradeDate: string): Promise<PositionL4Context> {
  try {
    const plan = await readL4ExecutionPlan(env, undefined, tradeDate)
    if (!plan) return { status: 'unavailable', reason: 'plan_missing' }
    const signalDate = await getPrevTradingDay(databaseForDataDomain(env, 'core'), env.KV, tradeDate)
    if (plan.signal_date !== signalDate) return { status: 'unavailable', reason: 'plan_stale' }
    const config = await getTradingConfig(env.KV)
    if (!config.l4Distribution) return { status: 'unavailable', reason: 'l4_disabled' }
    await assertL4PlanCurrentPolicy(env, plan, config)
    return { status: 'ready', plan, tradeDate }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error && error.message === 'daily_plan_not_finalized'
      ? 'plan_not_finalized' : 'plan_unverified' }
  }
}

/** Intent relative to the decision anchor, not a new rebalance on every price tick. */
export function positionL4Assessment(context: PositionL4Context, symbol: string) {
  if (context.status !== 'ready') return context
  const { plan, tradeDate } = context
  const target = plan.targets[symbol]
  if (!target) return { status: 'unavailable' as const, reason: 'target_missing' }
  const weight = plan.execution_review?.weights[symbol] ?? target.weight
  const anchor = plan.account_anchor?.positions.find(row => row.symbol === symbol)
  const heldAtDecision = Boolean(anchor && anchor.shares > 0)
  const reference = heldAtDecision ? target.current_weight : target.weight
  const action = target.locked ? 'locked' : weight === 0 ? 'exit'
    : weight < reference - 1e-8 ? 'reduce' : weight > reference + 1e-8 ? 'increase' : 'hold'
  return { status: 'ready' as const, action, signal_date: plan.signal_date, trade_date: tradeDate,
    plan_id: plan.plan_id, review_checksum: plan.execution_review?.checksum ?? null,
    decision_weight: reference, target_weight: weight, optimizer_weight: target.weight,
    held_at_decision: heldAtDecision, decision_shares: anchor?.shares ?? null,
    reasons: plan.execution_review?.reasons[symbol] ?? [] }
}
