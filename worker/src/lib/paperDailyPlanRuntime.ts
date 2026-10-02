import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { readL4PortfolioPlan } from './l4PortfolioPlan'
import { verifyDailyReview, sealDailyReview, persistDailyReview, type DailyPlanReview, type RiskRestriction } from './paperDailyPlan'
export const dailyPlanOwner = (env:Bindings) => env.PAPER_DAILY_PLAN_OWNER === 'premarket_once_v1'
const today = () => new Date(paperExecutionNow()+8*3600_000).toISOString().slice(0,10)

/** An absent daily seal disables target execution, never protective position exits. */
export async function readL4ExecutionPlan(env:Bindings,planId?:string,tradeDate=today()) {
  if(!dailyPlanOwner(env)) return readL4PortfolioPlan(env,planId)
  const row=await paperDomainDatabase(env).prepare(`SELECT r.payload_json FROM paper_daily_plan_heads_v1 h
    JOIN paper_daily_plan_reviews_v1 r ON r.account_id=h.account_id AND r.trade_date=h.trade_date AND r.checksum=h.checksum
    WHERE h.account_id=? AND h.trade_date=?`).bind(paperAccountId(),tradeDate).first<{payload_json:string}>()
  if(!row) throw new Error('daily_plan_not_finalized')
  const review=JSON.parse(row.payload_json) as DailyPlanReview
  if(planId && planId!==review.planId) throw new Error('daily_plan_reference_changed')
  const plan=await readL4PortfolioPlan(env,review.planId)
  if(!plan) throw new Error('daily_plan_base_missing')
  await verifyDailyReview(plan,review)
  return {...plan,execution_review:review}
}
export async function restrictDailyExecutionPlan(env:Bindings,planId:string,restrictions:RiskRestriction[]) {
  const plan=await readL4ExecutionPlan(env,planId)
  if(!plan?.execution_review) throw new Error('daily_plan_not_finalized')
  const next=await sealDailyReview({plan,previous:plan.execution_review,tradeDate:today(),
    contextHash:plan.execution_review.contextHash,nowMs:paperExecutionNow(),restrictions})
  return persistDailyReview(paperDomainDatabase(env),plan,next)
}
