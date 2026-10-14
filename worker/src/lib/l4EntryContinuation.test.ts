import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { readL4EntryContinuation, type L4EntryAuthorization } from './l4EntryContinuation'
import { l4TargetExecutionDecision, type L4PortfolioPlan } from './l4PortfolioPlan'
import { acquirePaperBuyIntent } from './paperOrderIntent'
import { sealDailyReview, persistDailyReview } from './paperDailyPlan'
import { resolvePositionExit } from './positionExitArbiter'

const id='a'.repeat(64),day='2026-10-14'
async function fixture() {
  const f=l4NativeFixture();f.ports.nowMs=Date.parse(`${day}T11:20:20+08:00`)
  f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
  const plan:L4PortfolioPlan={schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',account_id:1,
    signal_date:'2026-10-13',plan_id:id,parent_plan_id:null,policy_identity:'b'.repeat(64),model_checksum:'c'.repeat(64),
    nav_at_decision:961382.63,account_anchor:{order_watermark:0,cash:1e6,positions:[],settlement:{unsettledBuyAmount:0,unsettledSellAmount:0}},
    weights:{'2327':.125},targets:{'2327':{weight:.125,current_weight:0,locked:false,expected_return_gross:.0304226}},
    constraints:{exposure_cap:.45,name_cap:.125,min_weight:.03,max_positions:5},
    proof:{within_tolerance:true,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:1,preselection:false},
    opb:{enabled:false,status:'fixed_policy',arm_id:'base'}}
  const review=await sealDailyReview({plan,tradeDate:day,contextHash:'d'.repeat(64),
    nowMs:Date.parse(`${day}T08:00:00+08:00`),restrictions:[]})
  plan.execution_review=review
  const a:L4EntryAuthorization={schema:'l4-entry-authorization-v1',id:`${id}:${review.checksum}:${day}:2327`,
    planId:id,review:review.checksum,tradeDate:day,symbol:'2327',requestedShares:193,maxPrice:622,
    grossBudget:120247,expiresAtMs:Date.parse(`${day}T11:21:00+08:00`)}
  const buy=(qty:number,auth=a)=>f.sqls.paper.prepare(`INSERT INTO paper_orders
    (account_id,symbol,side,shares,price,total_cost,note,created_at) VALUES(1,'2327','buy',?,622,?,?,'2026-10-14 03:20:00')`)
    .run(qty,qty*622,JSON.stringify({l4_plan_id:id,entry_authorization:auth,paper_child_terminal:true}))
  const read=()=>withPaperExecutionScope(f.ports,()=>readL4EntryContinuation(f.env,day,'2327',id,review.checksum))
  return {f,plan,a,buy,read}
}
test('2327 original193:100 filled permits93; full193 never authorizes194 despite NAV rise',async()=>{
  const {f,plan,buy,read}=await fixture()
  try {
    buy(100);let c=(await read()).result!;assert.equal(c.remainingShares,93)
    const input={plan,symbol:'2327',holdings:[{symbol:'2327',shares:100,avgCost:622,lastPrice:622}],
      nav:961382.63,cash:8e5,dailyRemaining:8e5,riskExposureCap:.45,nameCap:.125,maxPositions:5,
      hardVeto:false,feeRate:.001425,minCommission:20,continuation:c}
    const decide=async(args:typeof input)=>(await withPaperExecutionScope(f.ports,async()=>l4TargetExecutionDecision(args))).result
    assert.equal((await decide(input)).action,'add')
    assert.equal((await withPaperExecutionScope(f.ports,async()=>l4TargetExecutionDecision({...input,continuation:null}))).result.reason,'daily_plan_existing_position')
    assert.equal((await decide({...input,hardVeto:true})).budgetCap,0)
    buy(93);c=(await read()).result!;assert.equal(c.remainingShares,0)
    assert.equal((await decide({...input,nav:2e6,holdings:[{symbol:'2327',shares:193,avgCost:622,lastPrice:622}],continuation:c})).budgetCap,0)
  } finally {f.close()}
})
test('expiry, changed review and an intervening sell cannot reopen a remainder',async()=>{
  const {f,plan,a,buy,read}=await fixture()
  try {
    buy(100)
    const other=await withPaperExecutionScope(f.ports,()=>readL4EntryContinuation(f.env,day,'2327',id,'e'.repeat(64)))
    assert.equal(other.result,null)
    f.ports.nowMs=a.expiresAtMs;assert.equal((await read()).result,null)
    f.ports.nowMs=a.expiresAtMs-1
    f.sqls.paper.prepare("INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,created_at) VALUES(1,'2327','sell',1,622,622,'2026-10-14 03:20:10')").run()
    assert.equal((await read()).result,null)
  } finally {f.close()}
})
test('forged quantity or changed original authorization fails closed',async()=>{
  const {f,a,buy,read}=await fixture()
  try {
    buy(100);buy(94)
    await assert.rejects(read(),/exceeds_authorization/)
    f.sqls.paper.exec('DELETE FROM paper_orders')
    buy(100);buy(1,{...a,maxPrice:623})
    await assert.rejects(read(),/authorization_changed/)
  } finally {f.close()}
})
test('continuation intent CAS admits only one writer; an overnight holding has no entitlement',async()=>{
  const {f,plan,buy}=await fixture()
  try {
    buy(100)
    f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
    f.sqls.paper.prepare('INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,allocation_snapshot_id,payload_json) VALUES(?,1,?,?,?,?)')
      .run(id,plan.signal_date,plan.policy_identity,'f'.repeat(64),JSON.stringify(plan))
    f.sqls.paper.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(id)
    await persistDailyReview(f.env.PAPER_DB,plan,plan.execution_review!,plan.execution_review!.finalizedAtMs)
    f.sqls.paper.prepare("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost) VALUES(1,'2327','國巨',100,622)").run()
    const rev={planId:id,currentShares:100,dailyReview:plan.execution_review!.checksum}
    const acquire=()=>withPaperExecutionScope(f.ports,()=>acquirePaperBuyIntent(f.env,day,'2327',rev))
    assert.equal((await acquire()).result.acquired,true)
    assert.equal((await acquire()).result.acquired,false)
    f.sqls.paper.exec('DELETE FROM paper_orders;DELETE FROM paper_order_intents')
    assert.equal((await acquire()).result.reason,'daily_plan_no_original_remainder')
  } finally {f.close()}
})
test('a partial portfolio cap reduction cannot suppress a full hard stop',()=>{
  const result=resolvePositionExit({positionShares:193,
    positionDecision:{action:'full_sell',exitIntentKind:'risk_stop',reason:'Swing -8%'},
    riskDecision:{action:'partial_sell',exitIntentKind:'risk_stop',sellShares:71,reason:'cap8%'}})
  assert.equal(result.decision.action,'full_sell')
})
