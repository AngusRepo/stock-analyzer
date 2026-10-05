import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {l4NativeFixture} from './l4NativeFixture.testSupport'
import {sealDailyReview,verifyDailyReview,persistDailyReview,reviewedTarget} from './paperDailyPlan'
const date='2026-10-02', clock=(s:string)=>Date.parse(date+'T'+s+':00+08:00')
const plan:any={account_anchor:{positions:[{symbol:'B',shares:2000},{symbol:'C',shares:2000},{symbol:'D',shares:1000}]},schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',account_id:1,signal_date:'2026-10-01',
  plan_id:'a'.repeat(64),parent_plan_id:null,model_checksum:'b'.repeat(64),policy_identity:'c'.repeat(64),nav_at_decision:1e6,
  weights:{A:.2,B:.2,C:0,D:.1},targets:{A:{weight:.2,current_weight:0,locked:false},B:{weight:.2,current_weight:.2,locked:false},
    C:{weight:0,current_weight:.2,locked:false},D:{weight:.1,current_weight:.1,locked:true}},
  constraints:{name_cap:.3,min_weight:.03,max_positions:5,exposure_cap:.8},
  proof:{within_tolerance:true,preselection:false,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:4}}
const base={plan,tradeDate:date,contextHash:'e'.repeat(64),nowMs:clock('08:10'),restrictions:[]}
test('deterministic restrictions only reduce weights, leave cash, and retain the original proof',async()=>{
  const before=JSON.stringify(plan)
  const review=await sealDailyReview({...base,restrictions:[{symbol:'A',maxWeight:.1,reason:'news risk'},{symbol:'B',maxWeight:0,reason:'veto'}]})
  assert.deepEqual(review.weights,{A:.1,B:0,C:0,D:.1});assert.equal(JSON.stringify(plan),before)
  assert.equal(reviewedTarget(plan,review,'C')?.weight,0);assert.equal(reviewedTarget(plan,review,'missing'),null)
  assert.equal(reviewedTarget(plan,review,'D')?.locked,true);await verifyDailyReview(plan,review)
})
test('08:45 is a hard first-publication boundary; later revisions cannot restore or add',async()=>{
  await sealDailyReview({...base,nowMs:clock('08:44')+59_999})
  await assert.rejects(sealDailyReview({...base,nowMs:clock('08:45')}),/invalid/)
  const first=await sealDailyReview(base)
  const cut=await sealDailyReview({...base,previous:first,nowMs:clock('10:00'),restrictions:[{symbol:'A',maxWeight:0,reason:'late negative evidence'}]})
  const again=await sealDailyReview({...base,previous:cut,nowMs:clock('10:05'),restrictions:[{symbol:'A',maxWeight:.2,reason:'late negative evidence'}]})
  assert.equal(again.checksum,cut.checksum);assert.equal(cut.finalizedAtMs,first.finalizedAtMs)
  await assert.rejects(sealDailyReview({...base,previous:cut,restrictions:[{symbol:'NEW',maxWeight:.1,reason:'replacement'}]}),/invalid/)
  await assert.rejects(sealDailyReview({...base,restrictions:[{symbol:'D',maxWeight:0,reason:'missing data'}]}),/locked/)
})
test('same-day plan is immutable; replay and competing caps use compare-and-swap',async()=>{
  const f=l4NativeFixture();f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
  try {
    const one=await sealDailyReview(base);await persistDailyReview(f.env.PAPER_DB,plan,one,base.nowMs);await persistDailyReview(f.env.PAPER_DB,plan,one,base.nowMs)
    const otherPlan={...plan,plan_id:'f'.repeat(64)}
    await assert.rejects(persistDailyReview(f.env.PAPER_DB,otherPlan,await sealDailyReview({...base,plan:otherPlan}),base.nowMs),/frozen/)
    const two=await sealDailyReview({...base,previous:one,restrictions:[{symbol:'A',maxWeight:.1,reason:'cap'}]})
    const race=await sealDailyReview({...base,previous:one,restrictions:[{symbol:'B',maxWeight:.1,reason:'cap'}]})
    await persistDailyReview(f.env.PAPER_DB,plan,two);await persistDailyReview(f.env.PAPER_DB,plan,two)
    await assert.rejects(persistDailyReview(f.env.PAPER_DB,plan,race),/conflict/)
    const row:any=f.sqls.paper.prepare('SELECT * FROM paper_daily_plan_heads_v1').get();assert.equal(row.checksum,two.checksum)
    const forged={...two,weights:{...two.weights,A:.2}};await assert.rejects(verifyDailyReview(plan,forged),/checksum/)
  }finally{f.close()}
})

test('execution consumes reviewed weights; cap outbox performs zero optimizer calls',async()=>{
  const {readL4ExecutionPlan}=await import('./paperDailyPlanRuntime')
  const {withPaperExecutionScope,advancePaperExecutionClock}=await import('./paperExecutionScope')
  const {requestL4Replan,flushL4Replans}=await import('./l4Replan')
  const {l4TargetExecutionDecision,l4TargetExitShares}=await import('./l4PortfolioPlan')
  const {acquirePaperBuyIntent,completePaperBuyIntent}=await import('./paperOrderIntent')
  const f=l4NativeFixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';f.ports.nowMs=base.nowMs
  f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
  f.sqls.paper.prepare(`INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,allocation_snapshot_id,payload_json,activated)
    VALUES(?,?,?,?,?,?,1)`).run(plan.plan_id,1,plan.signal_date,plan.policy_identity,'f'.repeat(64),JSON.stringify(plan))
  f.sqls.paper.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(plan.plan_id)
  try { await withPaperExecutionScope(f.ports,async()=>{
    await assert.rejects(readL4ExecutionPlan(f.env),/not_finalized/)
    const first=await sealDailyReview(base)
    await assert.rejects(persistDailyReview(f.env.PAPER_DB,plan,first,clock('10:00')),/publication_cutoff/)
    await persistDailyReview(f.env.PAPER_DB,plan,first)
    advancePaperExecutionClock(clock('10:00'))
    await requestL4Replan(f.env,plan.plan_id,['B'],'debate_risk_reject',{A:.1})
    assert.equal(await flushL4Replans(f.env,plan.signal_date),true)
    assert.deepEqual((await readL4ExecutionPlan(f.env))!.execution_review?.weights,plan.weights)
    assert.equal((f.sqls.paper.prepare("SELECT status FROM l4_replan_outbox_v1 WHERE json_extract(request_json,'$.reason')='debate_risk_reject'").get() as any).status,'expired')
    await requestL4Replan(f.env,plan.plan_id,['B'],'execution_hard_risk_veto',{A:.1})
    assert.equal(await flushL4Replans(f.env,plan.signal_date),true)
    const view=(await readL4ExecutionPlan(f.env))!
    assert.deepEqual(view.execution_review?.weights,{A:.1,B:0,C:0,D:.1})
    assert.deepEqual(view.weights,plan.weights,'optimizer proof stays intact')
    assert.equal(l4TargetExitShares({plan:view,symbol:'B',shares:2000,price:100,nav:1e6,minTradeValue:30000}),2000)
    assert.equal(l4TargetExitShares({plan:view,symbol:'missing',shares:2000,price:100,nav:1e6,minTradeValue:30000}),0)
    const buy=l4TargetExecutionDecision({plan:view,symbol:'A',holdings:[],nav:1e6,cash:1e6,dailyRemaining:1e6,
      riskExposureCap:.8,nameCap:.3,maxPositions:5,hardVeto:false,feeRate:.0004,minCommission:20})
    assert.equal(buy.budgetCap,100000)
    const stale=await acquirePaperBuyIntent(f.env,date,'A',{planId:plan.plan_id,currentShares:0,dailyReview:first.checksum})
    assert.equal(stale.acquired,false)
    const fresh=await acquirePaperBuyIntent(f.env,date,'A',{planId:plan.plan_id,currentShares:0,dailyReview:view.execution_review!.checksum})
    assert.equal(fresh.acquired,true)
    const revised=await sealDailyReview({...base,previous:view.execution_review,restrictions:[{symbol:'A',maxWeight:0,reason:'risk'}]})
    await assert.rejects(persistDailyReview(f.env.PAPER_DB,plan,revised),/raced/,'a running buy owns its admission boundary')
    await completePaperBuyIntent(f.env,fresh.intentKey,'filled',1)
    await persistDailyReview(f.env.PAPER_DB,plan,revised)
    assert.equal((await acquirePaperBuyIntent(f.env,date,'A',{planId:plan.plan_id,currentShares:0,dailyReview:revised.checksum})).acquired,false)
    assert.equal((f.sqls.paper.prepare("SELECT COUNT(*) AS n FROM l4_replan_outbox_v1 WHERE status='pending'").get() as any).n,0)
  }) }finally{f.close()}
})

test('fixed plan does not trim a rally; explicit reduction survives partial fills without moving the target',async()=>{
  const {l4TargetExitShares}=await import('./l4PortfolioPlan')
  const plain={...plan,execution_review:await sealDailyReview(base)}
  assert.equal(l4TargetExitShares({plan:plain,symbol:'B',shares:2000,price:130,nav:1060000,minTradeValue:1}),0)
  const cut=await sealDailyReview({...base,restrictions:[{symbol:'B',maxWeight:.1,reason:'cap'}]})
  const view={...plan,execution_review:cut}
  assert.equal(l4TargetExitShares({plan:view,symbol:'B',shares:2000,price:130,nav:1060000,minTradeValue:1}),1000)
  assert.equal(l4TargetExitShares({plan:view,symbol:'B',shares:1500,price:145,nav:1070000,minTradeValue:1}),500)
  assert.equal(l4TargetExitShares({plan:view,symbol:'B',shares:1000,price:160,nav:1080000,minTradeValue:1}),0)
})

test('full five-slot account waits for actual sale; planned replacement alone cannot buy',async()=>{
 const {l4TargetExecutionDecision}=await import('./l4PortfolioPlan')
 const view={...plan,execution_review:await sealDailyReview(base)}
 const holdings=['B','C','D','E','F'].map(symbol=>({symbol,shares:1000,avgCost:100,lastPrice:100,score:50}))
 const input:any={plan:view,symbol:'A',holdings,nav:1e6,cash:500000,dailyRemaining:1e6,riskExposureCap:.8,nameCap:.3,maxPositions:5,hardVeto:false,feeRate:.0004,minCommission:20}
 assert.notEqual(l4TargetExecutionDecision(input).action,'buy')
 assert.equal(l4TargetExecutionDecision({...input,holdings:holdings.slice(1)}).action,'buy')
 assert.notEqual(l4TargetExecutionDecision({...input,holdings:holdings.slice(1),cash:0}).action,'buy')
})
