import assert from 'node:assert/strict'
import test from 'node:test'
import { rotationCreditsSatisfied,checkL4RotationGate } from './l4RotationGate'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { l4TargetExitShares,validateL4PortfolioPlan } from './l4PortfolioPlan'
import { resolvePositionExit } from './positionExitArbiter'

const plan:any={schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',account_id:1,
  signal_date:'2026-10-13',plan_id:'a'.repeat(64),parent_plan_id:null,model_checksum:'b'.repeat(64),policy_identity:'c'.repeat(64),
  nav_at_decision:961382.63,account_anchor:{order_watermark:98,cash:963968.63,positions:[{symbol:'3374',shares:204}],settlement:{unsettledBuyAmount:97548,unsettledSellAmount:0}},
  weights:{'3374':0,'2327':.125},targets:{'3374':{weight:0,current_weight:.09877648819180351,locked:false,expected_return_gross:.01595809},
    '2327':{weight:.125,current_weight:0,locked:false,expected_return_gross:.03042264}},
  constraints:{exposure_cap:.45,name_cap:.125,min_weight:.03,max_positions:5},
  proof:{within_tolerance:true,preselection:false,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:2},
  sealed_execution:{schema_version:'l4-sealed-execution-v1',rotation_mode:'selected_ready_or_filled',expiry:'retain_until_next_seal',
    exit_rules:{'3374':{mode:'selected_ready_or_filled',reason:'positive_incumbent_conditional_rotation',expiry:'retain_until_next_seal',
      credits:[{symbol:'2327',credit_start:0,credit_end:94407.32}]}}}}
test('3374 zero is deferred until its sealed2327 leg qualifies; original plans retain their original behavior',()=>{
  const input={plan,symbol:'3374',shares:204,price:470.5,nav:961382.63,minTradeValue:30000}
  assert.equal(l4TargetExitShares(input),0)
  assert.equal(l4TargetExitShares({...input,rotationSatisfied:true}),204)
  const original=structuredClone(plan);delete original.sealed_execution
  assert.equal(l4TargetExitShares({...input,plan:original}),204)
  assert.equal(resolvePositionExit({positionShares:204,positionDecision:{action:'full_sell',reason:'hard stop',exitIntentKind:'risk_stop'}}).decision.action,'full_sell')
})
test('100 filled2327 shares are insufficient;193 qualify; expired readiness cannot sell',()=>{
  const credits=plan.sealed_execution.exit_rules['3374'].credits
  assert.equal(rotationCreditsSatisfied(credits,{'2327':{grossCredit:100*622,preparedGross:0}},1000),false)
  assert.equal(rotationCreditsSatisfied(credits,{'2327':{grossCredit:193*622,preparedGross:0}},1000),true)
  assert.equal(rotationCreditsSatisfied(credits,{'2327':{grossCredit:0,preparedGross:193*622,validUntilMs:2000}},1999),true)
  assert.equal(rotationCreditsSatisfied(credits,{'2327':{grossCredit:0,preparedGross:193*622,validUntilMs:2000}},2000),false)
  assert.equal(rotationCreditsSatisfied(credits,{'2337':{grossCredit:200000,preparedGross:0}},1000),false)
})
test('tampered replacement, reused credit and inherited correlation growth are rejected',()=>{
  const missing=structuredClone(plan);missing.sealed_execution.exit_rules['3374'].credits[0].symbol='1101'
  assert.throws(()=>validateL4PortfolioPlan(missing),/credit_invalid/)
  const reused=structuredClone(plan);reused.sealed_execution.exit_rules['3374'].credits.push({...reused.sealed_execution.exit_rules['3374'].credits[0]})
  assert.throws(()=>validateL4PortfolioPlan(reused),/credit_reused/)
  const pair=structuredClone(plan);pair.targets['3374'].weight=pair.weights['3374']=.075;delete pair.sealed_execution
  pair.constraints.excluded_pairs=[['3374','2327']]
  assert.throws(()=>validateL4PortfolioPlan(pair),/pair_limit_exceeded/)
})

test('rotation adapter uses actual same-plan ledger and retained shares; unrelated or exited fills cannot release3374',async()=>{
  const f=l4NativeFixture(),p=structuredClone(plan)
  f.ports.nowMs=Date.parse('2026-10-14T11:20:20+08:00')
  p.execution_review={tradeDate:'2026-10-14',weights:p.weights}
  try {
    const add=(shares:number,note:string)=>f.sqls.paper.prepare(`INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,note,created_at)
      VALUES(1,'2327','buy',?,622,?,?,'2026-10-14 03:20:00')`).run(shares,shares*622,note)
    add(1,'legacy human memo');add(193,JSON.stringify({l4_plan_id:p.plan_id}))
    const input={plan:p,symbol:'3374',reduceShares:204,nav:961382.63,cfg:f.cfg,
      positions:[{symbol:'3374',shares:204,entry_date:'2026-10-13'},{symbol:'2327',shares:193,entry_date:'2026-10-14'}],
      prices:new Map([['3374',470.5],['2327',622]]),risk:{halt:true,maxPositionPct:0,buyConfThreshold:.6,sellConfThreshold:.65}}
    const check=(i=input)=>withPaperExecutionScope(f.ports,()=>checkL4RotationGate(f.env,i))
    assert.equal((await check()).result.reason,'selected_fills_confirmed')
    assert.equal((await check({...input,positions:[input.positions[0]]})).result.satisfied,false)
    assert.equal((await check({...input,positions:[input.positions[0],{...input.positions[1],shares:100}]})).result.satisfied,false)
    f.sqls.paper.exec('DELETE FROM paper_orders')
    add(193,JSON.stringify({l4_plan_id:'f'.repeat(64)}))
    assert.equal((await check()).result.satisfied,false)
  } finally {f.close()}
})
