import {readSwingState} from './paperSwingLifecycle'
import {SWING_POLICY_VERSION} from './paperSwingPolicy'
import { readL4ExecutionPlan,dailyPlanOwner } from './paperDailyPlanRuntime'
import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { validateL4PortfolioPlan } from './l4PortfolioPlan'
import { getPrevTradingDay } from './paperMarketData'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperAccountId } from './paperExecutionScope'

export type L4AccountRewardResult = {
  status: 'disabled' | 'unavailable' | 'recorded'
  reason: string
  learning_eligible: boolean
  receipt_id?: string
}

/** Record the entire executed account, including cash and unsuccessful intents. */
export async function recordL4AccountReward(env: Bindings, day: string, endNav: number): Promise<L4AccountRewardResult> {
  const config = await env.KV.get('trading:config','json') as { l4Distribution?: unknown } | null
  if (!config?.l4Distribution) return { status: 'disabled', reason: 'l4_distribution_disabled', learning_eligible: false }
  if (!Number.isFinite(endNav) || endNav <= 0) throw new Error('l4_reward_nav_invalid')
  const previousSession = await getPrevTradingDay(databaseForDataDomain(env,'core'), env.KV, day)
  const db = paperDomainDatabase(env)
  const accountId = paperAccountId()
  const unavailable = (reason: string): L4AccountRewardResult => ({ status: 'unavailable', reason, learning_eligible: false })
  const { results } = await db.prepare('SELECT payload_json,created_at FROM l4_portfolio_plans_v1 WHERE account_id=? AND activated=1 AND signal_date=? ORDER BY rowid')
    .bind(accountId,previousSession).all<{ payload_json: string; created_at: string }>()
  // Account valuation remains valid without an attributable policy session.
  // Missing or late plans never create a zero-return learning receipt.
  if (!results.length) return unavailable('l4_reward_session_plan_missing')
  const plans = results.map(row => validateL4PortfolioPlan(JSON.parse(row.payload_json)))
  const first = plans[0]
  const sessionOpen = Date.parse(day+'T09:00:00+08:00')
  const publicationTimes = results.map(row => Date.parse(row.created_at.replace(' ', 'T')+'Z'))
  if (publicationTimes.some(time => !Number.isFinite(time))) throw new Error('l4_reward_plan_publication_time_invalid')
  if (publicationTimes[0] >= sessionOpen) return unavailable('l4_reward_plan_published_after_session_open')
  if (dailyPlanOwner(env)) {
    const head = await db.prepare('SELECT checksum FROM paper_daily_plan_heads_v1 WHERE account_id=? AND trade_date=?')
      .bind(accountId,day).first<{checksum:string}>()
    if (!head) return unavailable('l4_reward_daily_plan_not_finalized')
  }
  const dailyReview=dailyPlanOwner(env) ? (await readL4ExecutionPlan(env,undefined,day))?.execution_review : null
  if(dailyPlanOwner(env) && (!dailyReview || plans.length!==1 || dailyReview.planId!==first.plan_id))
    throw new Error('l4_reward_daily_plan_lineage_incomplete')
  if (dailyReview && dailyReview.finalizedAtMs >= sessionOpen)
    return unavailable('l4_reward_plan_finalized_after_session_open')
  const policies = new Set(plans.map(plan => `${plan.policy_identity}:${plan.opb.arm_id}`))
  const manual = await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE account_id=? AND source='manual' AND date(created_at,'+8 hours')=?")
    .bind(accountId,day).first<{n:number}>()
  let mixedExecution=false
  if(env.PAPER_INTRADAY_ENTRY_OWNER===SWING_POLICY_VERSION) {
    const {results:holdings}=await db.prepare('SELECT trade_lifecycle_json FROM paper_positions WHERE account_id=? AND shares>0').bind(accountId).all<{trade_lifecycle_json:string}>()
    mixedExecution=holdings.some(p=>!readSwingState(p.trade_lifecycle_json))
    const {results:trades}=await db.prepare("SELECT note FROM paper_orders WHERE account_id=? AND date(created_at,'+8 hours')=?").bind(accountId,day).all<{note:string}>()
    mixedExecution ||= trades.some(row=>{
      try {const n=JSON.parse(row.note);return n.execution_policy!==SWING_POLICY_VERSION} catch {return true}
    })
  }
  const receipt = { receipt_id: `${first.plan_id}:${day}`, known_date: day,
    execution_policy:env.PAPER_INTRADAY_ENTRY_OWNER ?? 'legacy',daily_review_checksum:dailyReview?.checksum ?? null,
    policy_identity: first.policy_identity, arm_id: first.opb.arm_id,
    reward_kind: 'complete_policy_account_net_return', complete: policies.size===1 && Number(manual?.n ?? 0)===0 && !mixedExecution,
    start_nav: first.nav_at_decision, end_nav: endNav,
    reward: endNav/first.nav_at_decision-1, plan_ids: plans.map(plan=>plan.plan_id),
    includes_cash: true, includes_costs: true, includes_failed_orders: true,
    reason: mixedExecution ? 'mixed_execution_policy' : policies.size!==1 ? 'mixed_policy_session' : Number(manual?.n ?? 0)>0 ? 'manual_trades_in_session' : 'complete_account' }
  const payload = JSON.stringify(receipt)
  await db.prepare('INSERT INTO l4_policy_account_rewards_v1(receipt_id,known_date,policy_identity,payload_json) VALUES(?,?,?,?) ON CONFLICT(receipt_id) DO NOTHING')
    .bind(receipt.receipt_id,day,receipt.policy_identity,payload).run()
  const saved = await db.prepare('SELECT payload_json FROM l4_policy_account_rewards_v1 WHERE receipt_id=?')
    .bind(receipt.receipt_id).first<{payload_json:string}>()
  if (saved?.payload_json!==payload) throw new Error('l4_reward_snapshot_changed_requires_reconciliation')
  return {status:'recorded', reason:receipt.reason, learning_eligible:receipt.complete, receipt_id:receipt.receipt_id}
}
