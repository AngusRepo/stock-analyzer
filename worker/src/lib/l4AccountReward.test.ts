import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { recordL4AccountReward } from './l4AccountReward'
import { sealDailyReview, persistDailyReview } from './paperDailyPlan'
import { runDailySnapshot } from './paperWorkerTasks'
import { withPaperExecutionScope } from './paperExecutionScope'

function fixture() {
  const f=l4NativeFixture()
  f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
  f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
  f.kvs.set('trading:config',JSON.stringify({l4Distribution:{}}))
  f.kvs.set('holiday:2026-10-09','National Day')
  const plan:any={schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',account_id:1,
    signal_date:'2026-10-08',plan_id:'a'.repeat(64),parent_plan_id:null,model_checksum:'b'.repeat(64),
    policy_identity:'c'.repeat(64),nav_at_decision:1e6,
    account_anchor:{order_watermark:0,cash:1e6,positions:[],settlement:{unsettledBuyAmount:0,unsettledSellAmount:0}},
    weights:{A:0},targets:{A:{weight:0,current_weight:0,locked:false,expected_return_gross:0}},
    constraints:{name_cap:.3,min_weight:0,max_positions:5,exposure_cap:.8},
    proof:{within_tolerance:true,preselection:false,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:1},
    opb:{enabled:false,status:'fixed_policy',arm_id:'base'}}
  const insert=(at='2026-10-12 00:00:00')=>{
    f.sqls.paper.prepare('INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json,created_at) VALUES(?,1,?,?,1,?,?,?)')
      .run(plan.plan_id,plan.signal_date,plan.policy_identity,'d'.repeat(64),JSON.stringify(plan),at)
    f.sqls.paper.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(plan.plan_id)
  }
  const seal=async(at='08:10:00')=>{
    const nowMs=Date.parse('2026-10-12T'+at+'+08:00')
    const review=await sealDailyReview({plan,tradeDate:'2026-10-12',contextHash:'e'.repeat(64),nowMs,restrictions:[]})
    await persistDailyReview(f.env.PAPER_DB,plan,review,nowMs)
  }
  const count=()=>f.sqls.paper.prepare('SELECT COUNT(*) n FROM l4_policy_account_rewards_v1').get()?.n
  return {...f,plan,insert,seal,count}
}
test('missing plan and missing daily seal are explicit unavailable, never invented rewards',async()=>{
  const f=fixture()
  try {
    assert.deepEqual(await recordL4AccountReward(f.env,'2026-10-12',1e6),
      {status:'unavailable',reason:'l4_reward_session_plan_missing',learning_eligible:false})
    f.insert()
    assert.equal((await recordL4AccountReward(f.env,'2026-10-12',1e6)).reason,'l4_reward_daily_plan_not_finalized')
    assert.equal(f.count(),0)
  } finally {f.close()}
})
test('late publication or finalization records an audit-only receipt, never learning credit',async()=>{
  for (const [published,finalized,reason] of [['2026-10-12 10:43:30','19:01:25','l4_reward_plan_published_after_session_open'],
    ['2026-10-12 00:00:00','19:01:25','l4_reward_plan_finalized_after_session_open']]) {
    const f=fixture()
    try {
      f.insert(published); await f.seal(finalized)
      const result=await recordL4AccountReward(f.env,'2026-10-12',1e6)
      assert.deepEqual([result.status,result.reason,result.learning_eligible],['recorded',reason,false])
      const saved=JSON.parse(String(f.sqls.paper.prepare('SELECT payload_json FROM l4_policy_account_rewards_v1').get()?.payload_json))
      assert.equal(saved.complete,false)
      assert.equal('effective_digest' in saved,false) // v1 plan payloads keep their receipt shape.
      assert.equal(f.count(),1)
    } finally {f.close()}
  }
})
test('valid preopen plan records once; changed NAV and corrupt review still fail',async()=>{
  const f=fixture()
  try {
    f.insert(); await f.seal()
    const first=await recordL4AccountReward(f.env,'2026-10-12',1010000)
    assert.equal(first.status,'recorded');assert.equal(first.learning_eligible,true)
    assert.deepEqual(await recordL4AccountReward(f.env,'2026-10-12',1010000),first)
    assert.equal(f.count(),1)
    await assert.rejects(recordL4AccountReward(f.env,'2026-10-12',1020000),/requires_reconciliation/)
    f.sqls.paper.exec("UPDATE paper_daily_plan_reviews_v1 SET payload_json='{}'")
    await assert.rejects(recordL4AccountReward(f.env,'2026-10-12',1010000))
    assert.equal(f.count(),1)
  } finally {f.close()}
})
test('real daily snapshot completes valuation and closure while reward is unavailable',async()=>{
  const f=fixture()
  try {
    f.ports.nowMs=Date.parse('2026-10-12T14:20:00+08:00')
    const {result}=await withPaperExecutionScope(f.ports,()=>runDailySnapshot(f.env,{date:'2026-10-12'}))
    assert.equal(result.valuation.nav,1e6)
    assert.equal(result.l4Reward?.reason,'l4_reward_session_plan_missing')
    assert.equal(f.sqls.paper.prepare("SELECT total_value FROM paper_daily_snapshots WHERE date='2026-10-12'").get()?.total_value,1e6)
    assert.equal(f.count(),0)
  } finally {f.close()}
})
