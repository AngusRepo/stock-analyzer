import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'
import { recordL4AccountReward } from './l4AccountReward'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { l4HasTargetBuyGap, assertL4PlanCurrentPolicy, validateL4PortfolioPlan, storeL4PortfolioPlan, readL4PortfolioPlan, l4TargetExecutionDecision, l4TargetExitShares, type L4PortfolioPlan } from './l4PortfolioPlan'
import { acquirePaperBuyIntent, completePaperBuyIntent } from './paperOrderIntent'
import { requestL4Replan, flushL4Replans } from './l4Replan'

async function main() {
  const sql=new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE paper_order_intents(intent_key TEXT PRIMARY KEY,account_id INTEGER,trade_date TEXT,symbol TEXT,side TEXT,source TEXT,status TEXT,created_at TEXT,updated_at TEXT,order_id INTEGER,error_message TEXT)`)
  sql.exec(readFileSync(new URL('../../domain-migrations/paper/0005_l4_distribution.sql',import.meta.url),'utf8'))
  sql.exec(`CREATE TABLE paper_exit_intents(account_id INTEGER,state TEXT); CREATE TABLE paper_orders(id INTEGER PRIMARY KEY,account_id INTEGER,source TEXT,created_at TEXT); CREATE TABLE paper_accounts(id INTEGER PRIMARY KEY,cash REAL);INSERT INTO paper_accounts VALUES(1,1000000); CREATE TABLE paper_positions(account_id INTEGER,symbol TEXT,shares INTEGER); CREATE TABLE paper_settlements(account_id INTEGER,settled INTEGER,side TEXT,amount REAL);`)
  function statement(query:string,args:any[]=[]):any {
    return {bind:(...values:any[])=>statement(query,values),
      first:async()=>sql.prepare(query).get(...args) ?? null,
      all:async()=>({results:sql.prepare(query).all(...args)}),
      run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}})}
  }
  const db:any={prepare:statement,batch:async(statements:any[])=>{
    sql.exec('BEGIN');try{const output=[];for(const s of statements)output.push(await s.run());sql.exec('COMMIT');return output}
    catch(e){sql.exec('ROLLBACK');throw e}
  }}
  const env:any={DB:db,PAPER_DB:db,MULTI_D1_ACTIVE_DOMAINS:'paper',MULTI_D1_STRICT:'true'}
  const unsigned:any={schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',parent_plan_id:null,
    account_anchor:{order_watermark:0,cash:1e6,positions:[],settlement:{unsettledBuyAmount:0,unsettledSellAmount:0}},
    policy_identity:'a'.repeat(64),model_checksum:'b'.repeat(64),signal_date:'2026-09-11',account_id:1,nav_at_decision:1e6,
    weights:{A:.3,B:.2,C:0},targets:{A:{weight:.3,current_weight:.1,locked:false,expected_return_gross:.02},
      B:{weight:.2,current_weight:0,locked:false,expected_return_gross:-.001},C:{weight:0,current_weight:.1,locked:false,expected_return_gross:-.02}},
    constraints:{exposure_cap:.8,name_cap:.3,min_weight:.03,max_positions:2},
    proof:{within_tolerance:true,absolute_objective_gap:1e-10,tolerance:1e-8,evaluated_candidate_count:3,preselection:false},
    opb:{enabled:false,status:'fixed_policy',arm_id:'base'}}
  function envelope(raw:any) {const canonical_payload=JSON.stringify(raw);return {
    plan:{...raw,plan_id:createHash('sha256').update(canonical_payload).digest('hex')},canonical_payload,allocation_snapshot_id:'c'.repeat(64)}}
  const l3={artifact_id:'l3-A',cohort_id:'cohort-A',payload_checksum:'d'.repeat(64),base_artifact_set_checksum:'e'.repeat(64)}
  unsigned.l3_identity=l3
  sql.exec(`CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)`)
  sql.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').run(...Object.values(l3))
  const policyEnv={...env,LEARNING_DB:db,MULTI_D1_ACTIVE_DOMAINS:'paper,learning'}
  const first=envelope(unsigned)
  const checksum=unsigned.model_checksum
  const receipt={schema_version:'l4-paper-acceptance-v1',feature_schema:L4_FEATURE_SCHEMA,checks:Object.fromEntries(L4_ACCEPTANCE_CHECKS.map(key=>[key,true])),model_checksum:checksum,acceptance_mode:'paper_experiment',
    efficacy_status:'unproven',experiment_authorization:{approved:true,scope:'paper',model_checksum:checksum,source_reference:'synthetic-test-only'}}
  const config={l4Distribution:{artifact:{feature_schema:L4_FEATURE_SCHEMA,model_checksum:checksum,l3_identity:l3,release:{scope:'paper',decision:'PASS',
    model_checksum:checksum,acceptance_mode:'paper_experiment',efficacy_status:'unproven',validation_receipt:receipt,validation_receipt_checksum:'f'.repeat(64)}}}}

  await assertL4PlanCurrentPolicy(policyEnv,first.plan,config)
  await assert.rejects(assertL4PlanCurrentPolicy(policyEnv,first.plan,{l4Distribution:{artifact:{...config.l4Distribution.artifact,model_checksum:'f'.repeat(64)}}}),/config_model_changed/)
  sql.exec("UPDATE active8_ensemble_pointer_v1 SET artifact_id='l3-B'")
  await assert.rejects(assertL4PlanCurrentPolicy(policyEnv,first.plan,config),/paired_l3_changed/)
  sql.exec("UPDATE active8_ensemble_pointer_v1 SET artifact_id='l3-A'")
  await storeL4PortfolioPlan(env,first)
  await storeL4PortfolioPlan(env,first)
  assert.equal((await readL4PortfolioPlan(env))?.plan_id,first.plan.plan_id)
  const forged=structuredClone(first);forged.plan.targets.A.expected_return_gross=99
  await assert.rejects(storeL4PortfolioPlan(env,forged),/checksum/)
  const second=envelope({...unsigned,parent_plan_id:first.plan.plan_id,nav_at_decision:1001000})
  await storeL4PortfolioPlan(env,second)
  const racing=envelope({...unsigned,parent_plan_id:first.plan.plan_id,nav_at_decision:1002000})
  await assert.rejects(storeL4PortfolioPlan(env,racing),/concurrent_change/)
  assert.equal(await readL4PortfolioPlan(env,racing.plan.plan_id),null)
  assert.equal((await readL4PortfolioPlan(env))?.plan_id,second.plan.plan_id)
  const invalid=structuredClone(first.plan);invalid.weights.B=.5;invalid.targets.B.weight=.5
  assert.throws(()=>validateL4PortfolioPlan(invalid),/target_invalid/)
  assert.equal(l4HasTargetBuyGap(first.plan,'A'),true)
  assert.equal(l4HasTargetBuyGap(first.plan,'C'),false)
  assert.equal(l4HasTargetBuyGap(first.plan,'A',{nav:1e6,price:100,shares:2999}),true)
  assert.equal(l4HasTargetBuyGap(first.plan,'A',{nav:999999,price:100,shares:2999}),false)
  assert.equal(l4HasTargetBuyGap(first.plan,'A',{nav:1e6,price:100,shares:3000}),false)
  assert.throws(()=>l4HasTargetBuyGap(first.plan,'A',{nav:NaN,price:100,shares:0}),/account_invalid/)
  const heldAtTarget=structuredClone(first.plan);heldAtTarget.targets.A.current_weight=.3
  assert.equal(l4HasTargetBuyGap(heldAtTarget,'A'),false)
  const base={plan:first.plan as L4PortfolioPlan,symbol:'A',holdings:[{symbol:'A',shares:1000,avgCost:100,lastPrice:100},
    {symbol:'C',shares:1000,avgCost:100,lastPrice:100}],nav:1e6,cash:8e5,dailyRemaining:1e6,
    riskExposureCap:.8,nameCap:.3,maxPositions:2,hardVeto:false,feeRate:.001425,minCommission:20}
  assert.equal(l4TargetExecutionDecision(base).budgetCap,200000)
  assert.equal(l4TargetExecutionDecision({...base,symbol:'B'}).action,'skip') // Unsold C consumes slot.
  assert.equal(l4TargetExecutionDecision({...base,hardVeto:true}).budgetCap,0)
  assert.equal(l4TargetExecutionDecision({...base,holdings:[{symbol:'A',shares:1600,avgCost:100,lastPrice:100}]}).budgetCap,140000)
  assert.equal(l4TargetExecutionDecision({...base,cash:100,reservedCash:90}).budgetCap,0)
  const grouped=structuredClone(first.plan) as L4PortfolioPlan
  grouped.constraints.exposure_groups={tech:{symbols:['A','B'],cap:.5,effective_cap:.5,locked_inherited_weight:0}}
  validateL4PortfolioPlan(grouped)
  const forgedGroup=structuredClone(grouped);forgedGroup.constraints.exposure_groups!.tech.effective_cap=.8
  assert.throws(()=>validateL4PortfolioPlan(forgedGroup),/group_limit/)
  // Actual B exposure still occupies the group budget before any planned sell.
  assert.ok(Math.abs(l4TargetExecutionDecision({...base,plan:grouped,holdings:[
    {symbol:'A',shares:1000,avgCost:100,lastPrice:100},{symbol:'B',shares:3900,avgCost:100,lastPrice:100}]}).budgetCap-10000)<1e-8)
  assert.equal(l4TargetExecutionDecision({...base,plan:grouped,holdings:[
    {symbol:'A',shares:1000,avgCost:100,lastPrice:100},{symbol:'B',shares:4000,avgCost:100,lastPrice:100}]}).budgetCap,0)
  const sell={plan:first.plan,symbol:'C',shares:1234,price:100,nav:1e6,minTradeValue:30000}
  assert.equal(l4TargetExitShares(sell),1234)
  assert.equal(l4TargetExitShares({...sell,symbol:'A',shares:4000}),1000)
  assert.equal(l4TargetExitShares({...sell,symbol:'A',shares:3100}),0)
  sql.exec("INSERT INTO paper_positions VALUES(1,'A',1000)")
  assert.equal((await acquirePaperBuyIntent(env,'2026-09-14','A',{planId:first.plan.plan_id,currentShares:1000})).acquired,false)
  assert.equal((await acquirePaperBuyIntent(env,'2026-09-14','A',{planId:second.plan.plan_id,currentShares:999})).acquired,false)
  const one=await acquirePaperBuyIntent(env,'2026-09-14','A',{planId:second.plan.plan_id,currentShares:1000})
  assert.equal(one.acquired,true)
  await completePaperBuyIntent(env,one.intentKey,'partial',1)
  assert.equal((await acquirePaperBuyIntent(env,'2026-09-14','A',{planId:second.plan.plan_id,currentShares:1000})).acquired,false)
  sql.exec("UPDATE paper_positions SET shares=1600 WHERE symbol='A'")
  assert.equal((await acquirePaperBuyIntent(env,'2026-09-14','A',{planId:second.plan.plan_id,currentShares:1600})).acquired,true)
  await requestL4Replan(env,first.plan.plan_id,['A'],'debate_risk_reject')
  await requestL4Replan(env,first.plan.plan_id,['A'],'debate_risk_reject')
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM l4_replan_outbox_v1').get()?.n,1)
  assert.equal(sql.prepare('SELECT status FROM l4_replan_outbox_v1').get()?.status,'pending')
  // A changed real account invalidates a previously computed plan even when the head is unchanged.
  sql.prepare('UPDATE paper_accounts SET cash=999900 WHERE id=1').run()
  const torn=envelope({...unsigned,parent_plan_id:second.plan.plan_id,nav_at_decision:1003000})
  await assert.rejects(storeL4PortfolioPlan(env,torn),/concurrent_change/)
  assert.equal(await readL4PortfolioPlan(env,torn.plan.plan_id),null)
  env.ML_CONTROLLER_URL='https://controller.invalid'
  const originalFetch=globalThis.fetch
  try {
    globalThis.fetch=async()=>new Response('{}',{status:503})
    assert.equal(await flushL4Replans(env,'2026-09-11'),false)
    assert.equal(sql.prepare('SELECT status FROM l4_replan_outbox_v1').get()?.status,'pending')
    assert.equal(sql.prepare('SELECT attempts FROM l4_replan_outbox_v1').get()?.attempts,1)
    globalThis.fetch=async()=>Response.json({status:'replanned',plan_id:second.plan.plan_id})
    assert.equal(await flushL4Replans(env,'2026-09-11'),true)
    assert.equal(sql.prepare('SELECT attempts FROM l4_replan_outbox_v1').get()?.attempts,2)
  } finally {globalThis.fetch=originalFetch}
  env.KV={get:async(key:string,type?:string)=>key==='trading:config'?{l4Distribution:{}}:null}
  await recordL4AccountReward(env,'2026-09-14',1010000)
  await recordL4AccountReward(env,'2026-09-14',1010000)
  const reward=JSON.parse(String(sql.prepare('SELECT payload_json FROM l4_policy_account_rewards_v1').get()?.payload_json))
  assert.equal(reward.complete,true)
  assert.ok(Math.abs(reward.reward-.01)<1e-12)
  assert.equal(reward.start_nav,1000000)
  assert.deepEqual(reward.plan_ids,[first.plan.plan_id,second.plan.plan_id]) // Never credit orphan plans.
  await assert.rejects(recordL4AccountReward(env,'2026-09-14',1020000),/requires_reconciliation/)
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM l4_policy_account_rewards_v1').get()?.n,1)
  sql.close()
  console.log('PASS L4 plan migration, checksum, activation race, legal shares, costs, partial-fill intents and durable veto')
}
main().catch(error=>{console.error(error);process.exitCode=1})
