import assert from 'node:assert/strict'
import test from 'node:test'
import { premarketWork } from './premarketEventWork'
import type { PremarketPayload, PremarketStage } from './premarketEventChain'
const oldId='a'.repeat(64), newId='b'.repeat(64), date='2026-10-01'
function fixture() {
  const calls:string[]=[]
  let plan={plan_id:oldId,signal_date:'2026-09-30'}, identity='frozen'
  let state:any={meta:{status:'ready',run_id:1},pendingBuys:[{symbol:'1101',watch_points:[`l4_plan:${oldId}`],debate_verdict:'PENDING',debate_status:'pending'}]}
  let delivered=true, switchPlan=true, settled=0
  const work=premarketWork({} as any,date,{
    contextIdentity:async()=>identity,
    warmup:async()=>{calls.push('warmup')}, settle:async()=>{settled++},
    recoverPaperMorningSetup:async(env,day,settle)=>{calls.push('setup');await settle(env);return 'ready'},
    getTradingConfig:async()=>({l4Distribution:true} as any),
    readL4PortfolioPlan:async()=>plan as any,
    loadPendingBuySnapshot:async()=>state,
    reconcilePendingBuyDebates:async()=>{calls.push('debate');state.pendingBuys.forEach((x:any)=>{x.debate_verdict='APPROVE';x.debate_status='done'});return 'status=success'},
    flushL4Replans:async()=>{calls.push('replan');if(switchPlan)plan={...plan,plan_id:newId};return delivered},
    setupMorningPendingBuys:async()=>{calls.push('rebuild');state={meta:{status:'ready',run_id:2},pendingBuys:[{symbol:'3311',watch_points:[`l4_plan:${newId}`],debate_verdict:'PENDING',debate_status:'pending'}]}},
  })
  return {work,calls,input:{context_hash:'frozen',signal_date:'2026-09-30'} as PremarketPayload,
    setDelivered:(v:boolean)=>{delivered=v},setSwitch:(v:boolean)=>{switchPlan=v},setState:(v:any)=>{state=v},setIdentity:(v:string)=>{identity=v},settled:()=>settled}
}
const guard=async()=>{}
test('setup immediately hands off; replan new candidates are debated before final readiness',async()=>{
 const f=fixture();let stage:PremarketStage|null='setup',input=f.input
 const ran:PremarketStage[]=[]
 while(stage){ran.push(stage);const result=await f.work(stage,input,guard);stage=result.next;input=result.receipt}
 assert.deepEqual(ran,['setup','debate:0','replan:0','publish:0','debate:1','replan:1','publish:1'])
 assert.deepEqual(f.calls,['warmup','setup','debate','replan','rebuild','debate','replan'])
 assert.equal(input.ready,true);assert.deepEqual(input.symbols,['3311']);assert.equal(input.plan_id,newId);assert.equal(f.settled(),1)
})
test('unchanged plan publishes without replacing the pending batch',async()=>{
 const f=fixture();f.setSwitch(false)
 const d=await f.work('debate:0',f.input,guard);await f.work('replan:0',d.receipt,guard)
 assert.equal((await f.work('publish:0',d.receipt,guard)).receipt.ready,true);assert.ok(!f.calls.includes('rebuild'))
})
test('undelivered L4 and changed evidence cannot publish readiness',async()=>{
 const f=fixture();f.setDelivered(false)
 await assert.rejects(f.work('replan:0',f.input,guard),/delivery_failed/)
 f.setIdentity('different');await assert.rejects(f.work('setup',f.input,guard),/context_changed/)
 assert.deepEqual(f.calls,['replan'])
})
test('missing run is not ready; bounded review rejects endless new candidates',async()=>{
 const f=fixture();f.setState({meta:undefined,pendingBuys:[]})
 await assert.rejects(f.work('publish:0',{...f.input,debated_plan_id:oldId},guard),/pending_publication/)
 const g=fixture();await g.work('replan:2',g.input,guard)
 await assert.rejects(g.work('publish:2',g.input,guard),/review_rounds_exhausted/)
})
test('explicit empty outcome is preserved for an unchanged plan',async()=>{
 const f=fixture();f.setState({meta:{status:'empty',run_id:1},pendingBuys:[]})
 const result=await f.work('publish:0',{...f.input,debated_plan_id:oldId},guard)
 assert.equal(result.receipt.ready,true);assert.equal(result.receipt.pending_status,'empty');assert.equal(f.calls.length,0)
})
