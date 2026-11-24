import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'
import { inspectL4DistributionClosure, verifyL4DailyClosure } from './l4DistributionClosure'

const id=(c:string)=>c.repeat(64)
const l3={artifact_id:'l3-A',cohort_id:'cohort-A',payload_checksum:id('d'),base_artifact_set_checksum:id('e')}
const model=id('b')

function plan(plan_id:string,signal_date:string,parent_plan_id:string|null) {
  return {schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',parent_plan_id,plan_id,signal_date,
    account_anchor:{order_watermark:0,cash:1e6,positions:[],settlement:{unsettledBuyAmount:0,unsettledSellAmount:0}},
    policy_identity:id('a'),model_checksum:model,account_id:1,nav_at_decision:1e6,l3_identity:l3,
    weights:{A:.3,B:.2,C:0},targets:{A:{weight:.3,current_weight:.1,locked:false,expected_return_gross:.02},
      B:{weight:.2,current_weight:0,locked:false,expected_return_gross:-.001},C:{weight:0,current_weight:.1,locked:false,expected_return_gross:-.02}},
    constraints:{exposure_cap:.8,name_cap:.3,min_weight:.03,max_positions:2},
    proof:{within_tolerance:true,absolute_objective_gap:1e-10,tolerance:1e-8,evaluated_candidate_count:3,preselection:false},
    opb:{enabled:false,status:'fixed_policy',arm_id:'base'}}
}

const P1119=id('1'),P1120=id('2'),P1123=id('3'),P1124=id('4'),OTHER=id('5')

/** 11-20 shape: 11-19 → 11-20 (traded) → 11-23 (head) [→ 11-24]. */
function fixture(head:string=P1123) {
  const sql=new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE paper_order_intents(intent_key TEXT PRIMARY KEY,account_id INTEGER,trade_date TEXT,symbol TEXT,side TEXT,source TEXT,status TEXT,created_at TEXT,updated_at TEXT,order_id INTEGER,error_message TEXT)`)
  sql.exec(readFileSync(new URL('../../domain-migrations/paper/0005_l4_distribution.sql',import.meta.url),'utf8'))
  sql.exec(`CREATE TABLE daily_recommendations(date TEXT,symbol TEXT,alpha_allocation TEXT,has_buy_signal INTEGER,eligible_for_pending_buy INTEGER);
    CREATE TABLE paired_nav_frozen_manifests_v1(snapshot_id TEXT PRIMARY KEY);
    CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT);`)
  sql.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').run(...Object.values(l3))
  const add=(p:ReturnType<typeof plan>,activated=1,snapshot=id('c'))=>{
    sql.prepare('INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json) VALUES(?,?,?,?,?,?,?)')
      .run(p.plan_id,1,p.signal_date,p.policy_identity,activated,snapshot,JSON.stringify(p))
    sql.prepare('INSERT OR IGNORE INTO paired_nav_frozen_manifests_v1 VALUES(?)').run(snapshot)
  }
  add(plan(P1119,'2026-11-19',null));add(plan(P1120,'2026-11-20',P1119));add(plan(P1123,'2026-11-23',P1120));add(plan(P1124,'2026-11-24',P1123))
  sql.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(head)
  const recommend=(day:string,planId:string)=>{for(const symbol of ['A','B','C'])
    sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run(day,symbol,JSON.stringify({expected_return_owner:'l4_distribution',plan_id:planId}))}
  recommend('2026-11-20',P1120);recommend('2026-11-23',P1123)
  function statement(query:string,args:any[]=[]):any {
    return {bind:(...values:any[])=>statement(query,values),first:async()=>sql.prepare(query).get(...args) ?? null,
      all:async()=>({results:sql.prepare(query).all(...args)})}
  }
  const db:any={prepare:statement}
  const receipt={schema_version:'l4-paper-acceptance-v1',feature_schema:L4_FEATURE_SCHEMA,checks:Object.fromEntries([...L4_ACCEPTANCE_CHECKS,
    'native_l3_baseline_preserved','incremental_comparison_contract'].map(key=>[key,true])),model_checksum:model,acceptance_mode:'paper_experiment',
    efficacy_status:'unproven',experiment_authorization:{approved:true,scope:'paper',model_checksum:model,source_reference:'synthetic-test-only'}}
  const config={l4Distribution:{scope:'paper',artifact:{schema_version:'l4-distribution-v1',feature_schema:L4_FEATURE_SCHEMA,model_checksum:model,l3_identity:l3,
    release:{scope:'paper',decision:'PASS',model_checksum:model,acceptance_mode:'paper_experiment',efficacy_status:'unproven',
      validation_receipt:receipt,validation_receipt_checksum:id('f')}}}}
  const kv:any={get:async(key:string)=>key==='trading:config'?config:null,put:async()=>{}}
  const env:any={DB:db,PAPER_DB:db,CORE_DB:db,LEARNING_DB:db,KV:kv,MULTI_D1_ACTIVE_DOMAINS:'paper,core,learning',MULTI_D1_STRICT:'true'}
  return {sql,env}
}

const closure=(day:string,planId:string,extra:Record<string,unknown>={})=>({schema_version:'l4-daily-plan-closure-v1',signal_date:day,plan_id:planId,
  model_checksum:model,legacy_oof_maturity_requested:false,training_dispatched:false,promoted:false,...extra})
const superseded=(by=P1123,byDate='2026-11-23')=>closure('2026-11-20',P1120,{superseded_by_plan_id:by,superseded_by_signal_date:byDate})

test('head plan path is unchanged', async()=>{
  const {env}=fixture(P1123)
  assert.equal((await verifyL4DailyClosure(env,closure('2026-11-23',P1123),'2026-11-23')).status,'verified')
  assert.equal((await inspectL4DistributionClosure(env,'2026-11-23')).ready,true)
  // Without the superseded marker an older day still needs the head plan.
  await assert.rejects(verifyL4DailyClosure(env,closure('2026-11-20',P1120),'2026-11-20'),/l4_daily_identity_mismatch/)
  assert.equal((await inspectL4DistributionClosure(env,'2026-11-20')).ready,false)
})

test('11-20: superseded receipt verifies against the original activated plan', async()=>{
  const {env}=fixture(P1123)
  const puts:string[]=[];env.KV.put=async(key:string)=>{puts.push(key)}
  const result=await verifyL4DailyClosure(env,superseded(),'2026-11-20')
  assert.equal(result.status,'verified');assert.equal(result.legacy_oof_maturity_credit,0)
  // The stored serving state keeps the current run date; only the head path refreshes it.
  assert.deepEqual(puts,[])
  await verifyL4DailyClosure(env,closure('2026-11-23',P1123),'2026-11-23')
  assert.deepEqual(puts,['expected-return:serving-state:v1'])
})

test('superseded receipt walks a longer head lineage to the named successor', async()=>{
  const {env}=fixture(P1124)
  assert.equal((await verifyL4DailyClosure(env,superseded(),'2026-11-20')).status,'verified')
  await assert.rejects(verifyL4DailyClosure(env,superseded(P1124,'2026-11-24'),'2026-11-20'),/l4_daily_identity_mismatch/)
})

test('superseded receipt fails closed without consistent evidence', async()=>{
  const cases:Array<[string,(f:ReturnType<typeof fixture>)=>void,Record<string,unknown>,RegExp]>=[
    ['original not activated',f=>f.sql.exec(`UPDATE l4_portfolio_plans_v1 SET activated=0 WHERE plan_id='${P1120}'`),superseded(),/identity_mismatch/],
    ['original missing',f=>f.sql.exec(`DELETE FROM l4_portfolio_plans_v1 WHERE plan_id='${P1120}'`),superseded(),/identity_mismatch/],
    ['multiple activated plans for the day',f=>f.sql.prepare('INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json) VALUES(?,1,?,?,1,?,?)')
      .run(OTHER,'2026-11-20',id('a'),id('c'),JSON.stringify(plan(OTHER,'2026-11-20',P1119))),superseded(),/identity_mismatch/],
    ['receipt plan_id differs',()=>{},{...superseded(),plan_id:P1119},/identity_mismatch/],
    ['successor plan_id differs',()=>{},superseded(P1124),/identity_mismatch/],
    ['successor date differs',()=>{},superseded(P1123,'2026-11-24'),/identity_mismatch/],
    ['marker incomplete',()=>{},closure('2026-11-20',P1120,{superseded_by_plan_id:P1123}),/identity_mismatch/],
    ['head lineage does not reach original',f=>f.sql.prepare('UPDATE l4_portfolio_plans_v1 SET payload_json=? WHERE plan_id=?')
      .run(JSON.stringify(plan(P1123,'2026-11-23',P1119)),P1123),superseded(),/identity_mismatch/],
    ['head is the day itself',f=>f.sql.exec(`UPDATE l4_portfolio_head_v1 SET plan_id='${P1120}'`),superseded(),/identity_mismatch/],
    ['recommendations name another plan',f=>f.sql.exec(`UPDATE daily_recommendations SET alpha_allocation=json_set(alpha_allocation,'$.plan_id','${P1119}') WHERE date='2026-11-20'`),
      superseded(),/l4_daily_recommendations_incomplete/],
    ['model differs from configuration',()=>{},{...superseded(),model_checksum:id('9')},/identity_mismatch/],
  ]
  for (const [name,mutate,receipt,error] of cases) {
    const f=fixture(P1123);mutate(f)
    await assert.rejects(verifyL4DailyClosure(f.env,receipt,'2026-11-20'),error,name)
  }
})

test('inspect with a superseded plan requires the recommendations to name that exact plan', async()=>{
  const {env}=fixture(P1123)
  assert.equal((await inspectL4DistributionClosure(env,'2026-11-20',plan(P1120,'2026-11-20',P1119) as any)).ready,true)
  assert.equal((await inspectL4DistributionClosure(env,'2026-11-20',plan(OTHER,'2026-11-20',P1119) as any)).ready,false)
})
