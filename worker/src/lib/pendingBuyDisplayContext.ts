import type { Bindings } from '../types'
import { readL4ExecutionPlan, dailyPlanOwner } from './paperDailyPlanRuntime'
import { planIdFromWatchPoints, type L4PortfolioPlan } from './l4PortfolioPlan'
import { paperDomainDatabase } from './paperDomainDatabase'

/** Display the signed plan, never invoke optimization or grant execution authority. */
export function projectPendingPlan(plan: L4PortfolioPlan | null, symbol: string, points: unknown, date: string) {
  if (!plan?.execution_review || plan.execution_review.tradeDate !== date) return null
  try { if (planIdFromWatchPoints(points) !== plan.plan_id) return null } catch { return null }
  const target = plan.targets[symbol]
  const weight = plan.execution_review.weights[symbol]
  if (!target || !Number.isFinite(weight)) return null
  return { plan_id: plan.plan_id, review_checksum: plan.execution_review.checksum,
    finalized_at: new Date(plan.execution_review.finalizedAtMs).toISOString(),
    target_weight: weight, target_value: weight * plan.nav_at_decision,
    locked: target.locked, basis: 'sealed_plan_nav', executable: false }
}
export async function loadPendingDisplayContext(env: Bindings, date: string,
  items: Array<{symbol: string; watch_points?: unknown}>) {
  const output = new Map<string, {planned_allocation: ReturnType<typeof projectPendingPlan>; today_fills: any}>()
  if (!items.length) return output
  const plan = dailyPlanOwner(env) ? await readL4ExecutionPlan(env, undefined, date).catch(() => null) : null
  const symbols = [...new Set(items.map(x => x.symbol))]
  const start = new Date(`${date}T00:00:00+08:00`).getTime()
  const sqlDate = (ms: number) => new Date(ms).toISOString().slice(0,19).replace('T',' ')
  const {results} = await paperDomainDatabase(env).prepare(`SELECT symbol, SUM(shares) shares,
    SUM(price*shares)/SUM(shares) average_price, MAX(created_at) last_fill_at, COUNT(*) order_count
    FROM paper_orders WHERE account_id=1 AND side='buy' AND created_at>=? AND created_at<?
    AND symbol IN (${symbols.map(()=>'?').join(',')}) GROUP BY symbol`)
    .bind(sqlDate(start),sqlDate(start+86_400_000),...symbols).all<any>()
    .catch(() => ({results: null}))
  for (const item of items) output.set(item.symbol, {
    planned_allocation: projectPendingPlan(plan,item.symbol,item.watch_points,date),
    today_fills: results?.find(row=>row.symbol===item.symbol) ?? null,
  })
  return output
}
