import {readSwingState} from './paperSwingLifecycle'
import {SWING_POLICY_VERSION} from './paperSwingPolicy'
import { readL4ExecutionPlan,dailyPlanOwner } from './paperDailyPlanRuntime'
import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { validateL4PortfolioPlan } from './l4PortfolioPlan'
import { getPrevTradingDay } from './paperMarketData'
import { databaseForDataDomain } from './dataDomainRegistry'

/** Record the entire executed account, including cash and unsuccessful intents. */
export async function recordL4AccountReward(env: Bindings, day: string, endNav: number) {
  const config = await env.KV.get('trading:config','json') as { l4Distribution?: unknown } | null
  if (!config?.l4Distribution) return
  if (!Number.isFinite(endNav) || endNav <= 0) throw new Error('l4_reward_nav_invalid')
  const previousSession = await getPrevTradingDay(databaseForDataDomain(env,'core'), env.KV, day)
  const db = paperDomainDatabase(env)
  const { results } = await db.prepare('SELECT payload_json FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 AND signal_date=? ORDER BY rowid')
    .bind(previousSession).all<{ payload_json: string }>()
  if (!results.length) throw new Error('l4_reward_session_plan_missing')
  const plans = results.map(row => validateL4PortfolioPlan(JSON.parse(row.payload_json)))
  const first = plans[0]
  const dailyReview=dailyPlanOwner(env) ? (await readL4ExecutionPlan(env,undefined,day))?.execution_review : null
  if(dailyPlanOwner(env) && (!dailyReview || plans.length!==1 || dailyReview.planId!==first.plan_id))
    throw new Error('l4_reward_daily_plan_lineage_incomplete')
  const policies = new Set(plans.map(plan => `${plan.policy_identity}:${plan.opb.arm_id}`))
  const manual = await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE account_id=1 AND source='manual' AND date(created_at,'+8 hours')=?")
    .bind(day).first<{n:number}>()
  let mixedExecution=false
  if(env.PAPER_INTRADAY_ENTRY_OWNER===SWING_POLICY_VERSION) {
    const {results:holdings}=await db.prepare('SELECT trade_lifecycle_json FROM paper_positions WHERE account_id=1 AND shares>0').all<{trade_lifecycle_json:string}>()
    mixedExecution=holdings.some(p=>!readSwingState(p.trade_lifecycle_json))
    const {results:trades}=await db.prepare("SELECT note FROM paper_orders WHERE account_id=1 AND date(created_at,'+8 hours')=?").bind(day).all<{note:string}>()
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
}
