import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'
import { inspectL4DistributionClosure, verifyL4DailyClosure, verifyL4DailyClosureWithRetry } from './l4DistributionClosure'

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
    prediction_coverage:{available:3,candidate_count:3,unavailable:{}},
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

/** 11-23 shape: the plan's targets are one sealed set; two of them (3718, 7856) are R33-unscored. */
function unscoredFixture() {
  const f=fixture(P1123)
  const p=plan(P1123,'2026-11-23',P1120) as any
  for (const symbol of ['3718','7856']) {
    p.targets[symbol]={weight:0,current_weight:0,locked:false,expected_return_gross:null};p.weights[symbol]=0
  }
  p.proof.evaluated_candidate_count=Object.keys(p.targets).length
  p.prediction_coverage.candidate_count=5 // A, B, C and the two unscored seed names
  f.sql.prepare('UPDATE l4_portfolio_plans_v1 SET payload_json=? WHERE plan_id=?').run(JSON.stringify(p),P1123)
  const unscored={engine:'sparse_tangent_inverse_risk',expected_return_owner:'l4_distribution',expected_return:null,selected:false,
    allocation_weight:0,selection_reason:'l3_evidence_unavailable',prediction_blockers:['r33_unscored:no_model_available'],plan_id:P1123}
  // Production leaves the screener's eligible_for_pending_buy=1 on these rows.
  for (const symbol of ['3718','7856'])
    f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,1)').run('2026-11-23',symbol,JSON.stringify(unscored))
  return {...f,unscored}
}
/** Both consumers of the closure: the watchdog/post-pipeline inspection and the callback verifier. */
const verdicts=async(env:any)=>{
  const inspected=await inspectL4DistributionClosure(env,'2026-11-23')
  const verified=await verifyL4DailyClosure(env,closure('2026-11-23',P1123),'2026-11-23').then(r=>r.status,e=>String(e.message))
  return {inspected,verified}
}
const rewritePlan=(f:ReturnType<typeof unscoredFixture>,edit:(p:any)=>void)=>{
  const p=JSON.parse((f.sql.prepare('SELECT payload_json FROM l4_portfolio_plans_v1 WHERE plan_id=?').get(P1123) as any).payload_json)
  edit(p);f.sql.prepare('UPDATE l4_portfolio_plans_v1 SET payload_json=? WHERE plan_id=?').run(JSON.stringify(p),P1123)
}

test('11-23: unscored plan targets served at weight 0 close the sealed set (counts and expected agree)', async()=>{
  const {env}=unscoredFixture()
  const {inspected,verified}=await verdicts(env)
  assert.equal(inspected.ready,true)
  assert.equal(inspected.recommendationRows,5)
  assert.equal(inspected.expectedRows,3);assert.equal(inspected.actualRows,3);assert.equal(inspected.rejectedLineageRows,0)
  assert.equal(verified,'verified')
})

test('11-23: an unscored target row with any buy, weight, selection or foreign identity stays not ready', async()=>{
  const cases:Array<[string,Record<string,unknown>|null,string?]>=[
    ['selected',{selected:true}],
    ['selected missing',{selected:undefined}],
    ['allocation weight',{allocation_weight:.01}],
    ['allocation weight missing',{allocation_weight:undefined}],
    ['expected return present',{expected_return:.01}],
    ['expected return missing',{expected_return:undefined}],
    ['other plan',{plan_id:P1119}],
    ['risk_abstention owner on a plan target',{expected_return_owner:'risk_abstention'}],
    ['portfolio reason',{selection_reason:'portfolio_cash_or_other_assets'}],
    ['unparseable allocation',null],
    ['buy flag',{},`UPDATE daily_recommendations SET has_buy_signal=1 WHERE date='2026-11-23' AND symbol='3718'`],
  ]
  for (const [name,patch,sql] of cases) {
    const f=unscoredFixture()
    if (patch) f.sql.prepare(`UPDATE daily_recommendations SET alpha_allocation=? WHERE date='2026-11-23' AND symbol='3718'`)
      .run(JSON.stringify({...f.unscored,...patch}))
    else f.sql.exec(`UPDATE daily_recommendations SET alpha_allocation='{' WHERE date='2026-11-23' AND symbol='3718'`)
    if (sql) f.sql.exec(sql)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,false,name)
    assert.match(verified,/l4_daily_recommendations_incomplete/,name)
  }
})

test('11-23: plan weight on an unscored target, a missing scored row, or a non-target row without abstention stays not ready', async()=>{
  const mutations:Array<[string,(f:ReturnType<typeof unscoredFixture>)=>void]>=[
    // A valid plan that sizes an unscored target (validateL4PortfolioPlan keeps weights[] equal to targets[].weight).
    ['plan target weight',f=>rewritePlan(f,p=>{p.targets['3718'].weight=.05;p.weights['3718']=.05;p.constraints.max_positions=3})],
    ['scored row missing',f=>f.sql.exec(`DELETE FROM daily_recommendations WHERE date='2026-11-23' AND symbol='A'`)],
    ['scored row tagged abstention',f=>f.sql.exec(`UPDATE daily_recommendations SET alpha_allocation=json_set(alpha_allocation,'$.expected_return_owner','risk_abstention') WHERE date='2026-11-23' AND symbol='A'`)],
    ['non-target row with the unscored shape',f=>f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run('2026-11-23','9999',JSON.stringify(f.unscored))],
    ['non-target abstention still eligible',f=>f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,1)')
      .run('2026-11-23','9999',JSON.stringify({expected_return_owner:'risk_abstention'}))],
    ['prototype key is not a target',f=>f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run('2026-11-23','constructor',JSON.stringify(f.unscored))],
    // Each copy alone is a valid exclusion; two rows for one symbol are not (same rule as the premarket receipt).
    ['duplicate non-target abstention row',f=>{for (let i=0;i<2;i++) f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)')
      .run('2026-11-23','9999',JSON.stringify({expected_return_owner:'risk_abstention'}))}],
  ]
  for (const [name,mutate] of mutations) {
    const f=unscoredFixture();mutate(f)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,false,name)
    assert.match(verified,/l4_daily_recommendations_incomplete/,name)
  }
  // A non-target row that abstains with no buy flags is still a valid exclusion.
  const f=unscoredFixture()
  f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run('2026-11-23','9999',JSON.stringify({expected_return_owner:'risk_abstention'}))
  const {inspected,verified}=await verdicts(f.env)
  assert.equal(inspected.ready,true);assert.equal(verified,'verified')
})

test('11-23: a duplicate scored row cannot stand in for a scored target with a foreign owner', async()=>{
  const f=unscoredFixture()
  f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run('2026-11-23','A',JSON.stringify({expected_return_owner:'l4_distribution',plan_id:P1123}))
  // C is a scored target but carries the abstention owner, so only the duplicate A makes the count match.
  f.sql.exec(`UPDATE daily_recommendations SET alpha_allocation=json_set(alpha_allocation,'$.expected_return_owner','risk_abstention','$.plan_id','${P1123}') WHERE date='2026-11-23' AND symbol='C'`)
  const {inspected,verified}=await verdicts(f.env)
  assert.equal(inspected.actualRows,3,'A twice and B match by owner and plan')
  assert.equal(inspected.ready,false)
  assert.match(verified,/l4_daily_recommendations_incomplete/)
})

test('superseded 11-20 plan with an unscored target closes on the same rule', async()=>{
  const f=fixture(P1123)
  const p=plan(P1120,'2026-11-20',P1119) as any
  p.targets['3718']={weight:0,current_weight:0,locked:false,expected_return_gross:null};p.weights['3718']=0
  p.proof.evaluated_candidate_count=Object.keys(p.targets).length
  p.prediction_coverage.candidate_count=4
  f.sql.prepare('UPDATE l4_portfolio_plans_v1 SET payload_json=? WHERE plan_id=?').run(JSON.stringify(p),P1120)
  const unscored={expected_return_owner:'l4_distribution',expected_return:null,selected:false,allocation_weight:0,
    selection_reason:'l3_evidence_unavailable',plan_id:P1120}
  f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,1)').run('2026-11-20','3718',JSON.stringify(unscored))
  assert.equal((await verifyL4DailyClosure(f.env,superseded(),'2026-11-20')).status,'verified')
  f.sql.prepare(`UPDATE daily_recommendations SET alpha_allocation=? WHERE date='2026-11-20' AND symbol='3718'`)
    .run(JSON.stringify({...unscored,selected:true}))
  await assert.rejects(verifyL4DailyClosure(f.env,superseded(),'2026-11-20'),/l4_daily_recommendations_incomplete/)
})

/** A held name the plan pins at its current weight (locked); max_positions leaves room for it. */
const holdLocked=(f:ReturnType<typeof unscoredFixture>,symbol:string,expected:number|null,weight=.05,current=weight)=>rewritePlan(f,p=>{
  p.targets[symbol]={weight,current_weight:current,locked:true,expected_return_gross:expected};p.weights[symbol]=weight
  p.constraints.max_positions=4;p.proof.evaluated_candidate_count=Object.keys(p.targets).length
})

test('11-23: a held, unscored name pinned at its plan weight closes; any mismatch stays not ready', async()=>{
  const lockedRow=(f:ReturnType<typeof unscoredFixture>,patch:Record<string,unknown>={})=>f.sql.prepare(
    `UPDATE daily_recommendations SET alpha_allocation=? WHERE date='2026-11-23' AND symbol='3718'`).run(JSON.stringify({...f.unscored,allocation_weight:.05,...patch}))
  {
    const f=unscoredFixture();holdLocked(f,'3718',null);lockedRow(f)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,true);assert.equal(verified,'verified');assert.equal(inspected.expectedRows,3)
  }
  const cases:Array<[string,(f:ReturnType<typeof unscoredFixture>)=>void]>=[
    ['target not locked',f=>{rewritePlan(f,p=>{p.targets['3718']={weight:.05,current_weight:.05,locked:false,expected_return_gross:null};p.weights['3718']=.05
      p.constraints.max_positions=4});lockedRow(f)}],
    ['row weight differs from plan weight',f=>{holdLocked(f,'3718',null);lockedRow(f,{allocation_weight:.04})}],
    ['row weight missing',f=>{holdLocked(f,'3718',null);lockedRow(f,{allocation_weight:undefined})}],
    ['plan weight off current within validator tolerance but row matches current',f=>{holdLocked(f,'3718',null,.05,.05+5e-9);lockedRow(f,{allocation_weight:.05+5e-9})}],
    ['buy flag',f=>{holdLocked(f,'3718',null);lockedRow(f);f.sql.exec(`UPDATE daily_recommendations SET has_buy_signal=1 WHERE date='2026-11-23' AND symbol='3718'`)}],
    ['selected',f=>{holdLocked(f,'3718',null);lockedRow(f,{selected:true})}],
    ['owner',f=>{holdLocked(f,'3718',null);lockedRow(f,{expected_return_owner:'risk_abstention'})}],
    ['other plan',f=>{holdLocked(f,'3718',null);lockedRow(f,{plan_id:P1119})}],
  ]
  for (const [name,mutate] of cases) {
    const f=unscoredFixture();mutate(f)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,false,name)
    assert.match(verified,/l4_daily_recommendations_incomplete/,name)
  }
})

test('11-23: a scored holding outside the seed (locked, no row) is not expected; anything else stays not ready', async()=>{
  {
    const f=unscoredFixture();holdLocked(f,'H',.01)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,true);assert.equal(verified,'verified');assert.equal(inspected.expectedRows,3)
  }
  const cases:Array<[string,(f:ReturnType<typeof unscoredFixture>)=>void]>=[
    ['not locked',f=>rewritePlan(f,p=>{p.targets.H={weight:.05,current_weight:.05,locked:false,expected_return_gross:.01};p.weights.H=.05
      p.constraints.max_positions=4;p.proof.evaluated_candidate_count=Object.keys(p.targets).length})],
    ['locked without a holding (weight 0)',f=>holdLocked(f,'H',.01,0,0)],
    ['unscored and not locked',f=>rewritePlan(f,p=>{p.targets.H={weight:0,current_weight:0,locked:false,expected_return_gross:null};p.weights.H=0
      p.proof.evaluated_candidate_count=Object.keys(p.targets).length})],
    ['a row with the wrong owner',f=>{holdLocked(f,'H',.01)
      f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run('2026-11-23','H',JSON.stringify({expected_return_owner:'risk_abstention',plan_id:P1123}))}],
  ]
  for (const [name,mutate] of cases) {
    const f=unscoredFixture();mutate(f)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,false,name)
    assert.match(verified,/l4_daily_recommendations_incomplete/,name)
  }
  // With its own row of the same plan the held name is an ordinary scored target.
  const f=unscoredFixture();holdLocked(f,'H',.01);rewritePlan(f,p=>{p.prediction_coverage.candidate_count=6})
  f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,0,0)').run('2026-11-23','H',JSON.stringify({expected_return_owner:'l4_distribution',plan_id:P1123}))
  const {inspected}=await verdicts(f.env)
  assert.equal(inspected.ready,true);assert.equal(inspected.expectedRows,4)
})

/** The core read fails with `message` for its first `failures` calls. */
function flakyCore(f:ReturnType<typeof unscoredFixture>,failures:number,message:string) {
  const inner=f.env.CORE_DB;let calls=0
  f.env.CORE_DB={prepare:(query:string)=>{
    const statement=inner.prepare(query)
    if (!query.includes('FROM daily_recommendations')) return statement
    const failing=()=>++calls<=failures
    return {bind:(...values:any[])=>{const bound=statement.bind(...values)
      return {...bound,all:async()=>{if (failing()) throw new Error(message);return bound.all()}}}}
  }}
  return {calls:()=>calls}
}

test('closure callback retries D1 capacity errors with bounded backoff, and only those', async()=>{
  const sleeps:number[]=[];const sleep=async(ms:number)=>{sleeps.push(ms)}
  {
    const f=unscoredFixture();const core=flakyCore(f,2,'D1_ERROR: D1 DB is overloaded. Requests queued for too long.')
    assert.deepEqual(await verifyL4DailyClosureWithRetry(f.env,closure('2026-11-23',P1123),'2026-11-23',{sleep}),{status:'verified'})
    assert.equal(core.calls(),3);assert.deepEqual(sleeps,[250,500])
  }
  {
    sleeps.length=0
    const f=unscoredFixture();const core=flakyCore(f,9,'Network connection lost.')
    assert.deepEqual(await verifyL4DailyClosureWithRetry(f.env,closure('2026-11-23',P1123),'2026-11-23',{sleep}),
      {status:'transient',reason:'Network connection lost.',attempts:3})
    assert.equal(core.calls(),3);assert.deepEqual(sleeps,[250,500])
  }
  {
    sleeps.length=0
    const f=unscoredFixture();const core=flakyCore(f,9,'D1_ERROR: no such column: symbol')
    assert.deepEqual(await verifyL4DailyClosureWithRetry(f.env,closure('2026-11-23',P1123),'2026-11-23',{sleep}),
      {status:'failed',reason:'D1_ERROR: no such column: symbol'})
    assert.equal(core.calls(),1);assert.deepEqual(sleeps,[])
  }
  {
    // A closure that is simply not ready is a deterministic failure: no retry.
    const f=unscoredFixture()
    f.sql.exec(`UPDATE daily_recommendations SET has_buy_signal=1 WHERE date='2026-11-23' AND symbol='3718'`)
    assert.deepEqual(await verifyL4DailyClosureWithRetry(f.env,closure('2026-11-23',P1123),'2026-11-23',{sleep}),
      {status:'failed',reason:'l4_daily_recommendations_incomplete'})
    assert.deepEqual(sleeps,[])
  }
})

test('the active8-oof-daily callback uses the bounded retry and records an exhausted retry as a retryable error (200)', ()=>{
  const routes=readFileSync(new URL('../routes/adminControlRoutes.ts',import.meta.url),'utf8')
  const start=routes.indexOf("const { verifyL4DailyClosureWithRetry }=await import('../lib/l4DistributionClosure')")
  assert.ok(start>0)
  const block=routes.slice(start,routes.indexOf('} else {\n    const { persistActive8OofFreshnessAudit }',start))
  // Exhausted transient is a recorded retryable error on the 200 path, never a 503 (see the handler comment).
  assert.doesNotMatch(block,/c\.json\([\s\S]*?503\)/)
  assert.match(block,/new_l4_daily_closure_verification_transient:retryable:attempts=\$\{verification\.attempts\}:\$\{verification\.reason\}/)
  assert.match(block,/: `new_l4_daily_closure_unverified:\$\{verification\.reason\}`/)
  assert.doesNotMatch(routes,/await verifyL4DailyClosure\(c\.env/)
})

test('11-23: a seed row that went missing is not mistaken for a holding outside the seed', async()=>{
  const cases:Array<[string,(f:ReturnType<typeof unscoredFixture>)=>void]>=[
    // A is held and locked but was a seed candidate (candidate_count still counts it): its row is required.
    ['locked scored holding lost its seed row',f=>{holdLocked(f,'A',.02,.1);f.sql.exec(`DELETE FROM daily_recommendations WHERE date='2026-11-23' AND symbol='A'`)}],
    ['locked unscored holding lost its seed row',f=>{holdLocked(f,'3718',null);f.sql.exec(`DELETE FROM daily_recommendations WHERE date='2026-11-23' AND symbol='3718'`)}],
    ['plan without a seed count',f=>rewritePlan(f,p=>{delete p.prediction_coverage})],
    ['a foreign-owner duplicate of a scored row',f=>f.sql.prepare('INSERT INTO daily_recommendations VALUES(?,?,?,1,1)')
      .run('2026-11-23','A',JSON.stringify({expected_return_owner:'l4_alpha_ev',plan_id:P1123}))],
  ]
  for (const [name,mutate] of cases) {
    const f=unscoredFixture();mutate(f)
    const {inspected,verified}=await verdicts(f.env)
    assert.equal(inspected.ready,false,name)
    assert.match(verified,/l4_daily_recommendations_incomplete/,name)
  }
  // An unscored holding outside the seed (locked, no row, not counted as a candidate) is fine.
  const f=unscoredFixture();holdLocked(f,'H2',null)
  const {inspected}=await verdicts(f.env)
  assert.equal(inspected.ready,true)
})

test('closure callback stops retrying once the next delay would pass its time budget', async()=>{
  const f=unscoredFixture();const core=flakyCore(f,9,'D1_ERROR: D1 DB is overloaded.')
  let clock=0;const sleeps:number[]=[]
  // Each failed attempt takes 3 s: after the first, 3 s + 250 ms fits in 6 s; after the second, 6.25 s + 500 ms does not.
  const inner=f.env.CORE_DB.prepare
  f.env.CORE_DB.prepare=(query:string)=>{const st=inner(query);if (!query.includes('FROM daily_recommendations')) return st
    return {bind:(...v:any[])=>{const b=st.bind(...v);return {...b,all:async()=>{clock+=3000;return b.all()}}}}}
  const result=await verifyL4DailyClosureWithRetry(f.env,closure('2026-11-23',P1123),'2026-11-23',
    {sleep:async ms=>{sleeps.push(ms);clock+=ms},now:()=>clock})
  assert.deepEqual(result,{status:'transient',reason:'D1_ERROR: D1 DB is overloaded.',attempts:2})
  assert.equal(core.calls(),2);assert.deepEqual(sleeps,[250])
})

/** Runs the real scheduler-callback handler for one active8-oof-daily callback carrying the native L4 closure. */
async function nativeClosureCallback(failure:string|null,continuationAttempt:number,continuationMaxAttempts=12) {
  const {adminControlRoutes}=await import('../routes/adminControlRoutes')
  const f=unscoredFixture()
  if (failure) flakyCore(f,99,failure)
  const ops=new DatabaseSync(':memory:')
  ops.exec(readFileSync(new URL('../../domain-migrations/ops/0011_scheduler_execution_tickets.sql',import.meta.url),'utf8'))
  const opsStatement=(query:string,args:any[]=[]):any=>({bind:(...values:any[])=>opsStatement(query,values),
    first:async()=>ops.prepare(query).get(...args) ?? null,all:async()=>({success:true,results:ops.prepare(query).all(...args)}),
    run:async()=>({success:true,meta:{changes:Number(ops.prepare(query).run(...args).changes)}})})
  const ticket='scheduler:active8-oof-daily-watchdog:2026-11-24T23:55:04Z:active8-oof-daily'
  ops.prepare(`INSERT INTO scheduler_execution_tickets_v1(ticket_id,dedupe_key,root_ticket_id,task,business_date,run_id,attempt_id,
    ticket_kind,status,status_authority,attempt_count,payload_checksum,last_summary,updated_at)
    VALUES(?,?,?,'active8-oof-daily','2026-11-23',?,?,'physical_root','running','scheduler_http',1,?,'dispatched','2026-11-24 23:55:05')`)
    .run(ticket,ticket,ticket,'ticket-run','ticket-run:attempt:1',id('b'))
  const kv=new Map<string,any>(), sent:Array<{message:any,options:any}>=[]
  const config=await f.env.KV.get('trading:config')
  f.env.KV={get:async(key:string,type?:string)=>key==='trading:config'?config:kv.has(key)?(type==='json'?kv.get(key):JSON.stringify(kv.get(key))):null,
    put:async(key:string,value:string)=>{kv.set(key,JSON.parse(value))},delete:async(key:string)=>{kv.delete(key)},list:async()=>({keys:[],list_complete:true})}
  const env={...f.env,OPS_DB:{prepare:opsStatement},MULTI_D1_ACTIVE_DOMAINS:'paper,core,learning,ops',STOCKVISION_AUTH_TOKEN:'local-fixture-only',
    UPDATE_QUEUE:{send:async(message:any,options:any)=>{sent.push({message,options})}}}
  const response=await adminControlRoutes.request('/api/admin/scheduler-callback',{method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer local-fixture-only'},
    body:JSON.stringify({task:'active8-oof-daily',status:'success',run_date:'2026-11-23',run_id:'active8-oof-daily:2026-11-23',
      attempt_id:'execution-1',summary:'run_id=active8-oof-daily:2026-11-23 status=native_l4_daily_accounted',
      scheduler_ticket_id:ticket,scheduler_run_id:'ticket-run',
      metadata:{cadence:'daily',lifecycle_status:'native_l4_daily_accounted',cohort_id:null,mode:'oof_lifecycle',
        continuation_attempt:continuationAttempt,continuation_max_attempts:continuationMaxAttempts,continuation_only:false,
        native_l4_daily_closure:closure('2026-11-23',P1123)}}),
  },env,{waitUntil:()=>{}} as any)
  const row=ops.prepare('SELECT status,last_error FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(ticket) as any
  return {status:response.status,sent,ticket:row,log:kv.get('scheduler:run:active8-oof-daily:2026-11-23')}
}

test('a transient closure verification continues through the bounded active8_oof_continuation queue, and errors once exhausted', async()=>{
  const overloaded='D1_ERROR: D1 DB is overloaded. Requests queued for too long.'
  {
    // Within the limit: 200, the job's ticket stays open, and the same day is re-dispatched with the next attempt.
    const r=await nativeClosureCallback(overloaded,0)
    assert.equal(r.status,200)
    assert.equal(r.sent.length,1)
    const m=r.sent[0].message
    assert.deepEqual({type:m.type,triggerTime:m.triggerTime,oofCadence:m.oofCadence,attempt:m.oofContinuationAttempt,
      ticket:m.schedulerTicketId,run:m.schedulerRunId,cohort:m.oofExpectedCohortId},
      {type:'active8_oof_continuation',triggerTime:'2026-11-23',oofCadence:'daily',attempt:1,
        ticket:'scheduler:active8-oof-daily-watchdog:2026-11-24T23:55:04Z:active8-oof-daily',run:'ticket-run',cohort:undefined})
    assert.equal(r.sent[0].options.delaySeconds,300)
    assert.equal(r.ticket.status,'running')
    assert.notEqual(r.log?.status,'error')
  }
  {
    // A later attempt inside the limit backs off on the existing policy.
    const r=await nativeClosureCallback(overloaded,3)
    assert.equal(r.sent.length,1);assert.equal(r.sent[0].message.oofContinuationAttempt,4);assert.equal(r.sent[0].options.delaySeconds,1800)
  }
  {
    // At the limit: nothing queued; the ticket and the run log record the retryable error.
    const r=await nativeClosureCallback(overloaded,12)
    assert.equal(r.status,200)
    assert.equal(r.sent.length,0)
    assert.equal(r.ticket.status,'error')
    assert.match(String(r.ticket.last_error),/^new_l4_daily_closure_verification_transient:retryable:attempts=3:D1_ERROR: D1 DB is overloaded/)
    assert.equal(r.log?.status,'error')
  }
  {
    // A deterministic failure is never continued.
    const r=await nativeClosureCallback('D1_ERROR: no such column: symbol',0)
    assert.equal(r.status,200)
    assert.equal(r.sent.length,0)
    assert.equal(r.ticket.status,'error')
    assert.match(String(r.ticket.last_error),/^new_l4_daily_closure_unverified:D1_ERROR: no such column: symbol/)
  }
  {
    // A verified closure settles success and queues nothing.
    const r=await nativeClosureCallback(null,0)
    assert.equal(r.status,200);assert.equal(r.sent.length,0);assert.equal(r.ticket.status,'success')
  }
})
