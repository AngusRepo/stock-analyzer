import assert from 'node:assert/strict'
import test from 'node:test'
import {premarketWork} from './premarketEventWork'
import {controllerUnavailable,dispatchSinglePlan,singlePlanContext} from './premarketSinglePlan'
import {l4NativeFixture} from './l4NativeFixture.testSupport'
import type {PremarketStage,PremarketPayload} from './premarketEventChain'
test('morning publication precedes advisory debate; debate failure preserves ready receipt',async()=>{
 const calls:string[]=[];const id='a'.repeat(64)
 const work=premarketWork({PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any,'2026-10-02',{
   warmup:async()=>{calls.push('warmup')},ensurePaperCorporateSource:async()=>{},settle:async()=>{calls.push('settle')},
   dispatchSinglePlan:async()=>{calls.push('allocate');return id},
   recoverPaperMorningSetup:async()=>{calls.push('pending');return 'ready'},
   reconcilePendingBuyDebates:async()=>{calls.push('debate');throw new Error('model unavailable')},
   loadPendingBuySnapshot:async()=>({pendingBuys:[],meta:{status:'empty'}} as any),
   readL4PortfolioPlan:async()=>({plan_id:id} as any),
   flushL4Replans:async()=>{throw new Error('optimizer must not be invoked')},
   contextIdentity:async()=>{throw new Error('sealed context cannot be refreshed')},
   finalizeSinglePlan:async(_e,_d,input)=>{calls.push('publish');return {...input,ready:true,plan_id:id,review_checksum:'f'.repeat(64),pending_run_id:1,pending_status:'ready',symbols:[]}},
 })
 let stage:PremarketStage|null='setup',input:PremarketPayload={context_hash:'f'.repeat(64),signal_date:'2026-10-01'}
 while(stage){const r=await work(stage,input,async()=>{});stage=r.next;input=r.receipt
   if(stage==='debate:0') {
     assert.equal(input.ready,true,'daily head must be ready before advisory debate runs')
     assert.deepEqual(calls,['warmup','settle','allocate','pending','publish'])
   }
 }
 assert.deepEqual(calls,['warmup','settle','allocate','pending','publish','debate'])
 assert.equal(input.ready,true,'advisory debate failure must not revoke readiness')
})

// 11/16: premarket-resume HTTP 500 burned all three allocate attempts at 07:20 while the
// premarket-state probe of the same controller was already a wait.
const receipt={run_id:'sealed-run',run_date:'2026-09-11',checksum:'c'}
const allocateInput={l3_receipt:receipt,morning_context:{trade_date:'2026-09-14',checksum:'m'}}
for(const [name,resume,expected] of [
 ['HTTP 500',async()=>new Response('Internal Server Error',{status:500}),/^Error: premarket_wait:controller_unavailable:Controller \/pipeline\/v2\/premarket-resume HTTP 500/],
 ['HTTP 503',async()=>new Response('',{status:503}),/premarket_wait:controller_unavailable:.*HTTP 503/],
 ['timeout',async()=>{throw new DOMException('The operation was aborted due to timeout','TimeoutError')},/premarket_wait:controller_unavailable:/],
 ['connection lost',async()=>{throw new TypeError('Network connection lost.')},/premarket_wait:controller_unavailable:Network connection lost/],
 ['HTTP 409 contract',async()=>new Response('{"detail":"premarket_owner_disabled"}',{status:409}),/^Error: Controller \/pipeline\/v2\/premarket-resume HTTP 409/],
 ['HTTP 400',async()=>new Response('bad',{status:400}),/^Error: Controller \/pipeline\/v2\/premarket-resume HTTP 400/],
 ['malformed 200',async()=>new Response('not json',{status:200}),/^SyntaxError/],
 ['reconciliation',async()=>Response.json({status:'reconciliation_required',reason:'premarket_dispatch_outcome_unknown'}),/^Error: premarket_dispatch_outcome_unknown$/],
 ['dispatched',async()=>Response.json({status:'dispatched'}),/^Error: premarket_wait:l4_completion$/],
] as const)test(`premarket-resume ${name}: unavailable controller waits, contract errors stay hard`,async()=>{
 const f=l4NativeFixture();f.env.ML_CONTROLLER_URL='https://controller.test';const original=globalThis.fetch
 globalThis.fetch=(async(url:string)=>String(url).includes('/premarket-state')?Response.json({status:'sealed',publication:null}):resume()) as typeof fetch
 try{
  const error=await dispatchSinglePlan(f.env,allocateInput).then(()=>null,(e:unknown)=>e)
  assert.match(String(error),expected)
  assert.equal(/premarket_wait:/.test(String(error)),!/contract|400|malformed|reconciliation/.test(name))
 }finally{globalThis.fetch=original;f.close()}
})
test('L3 seal probe treats an unavailable controller as a wait and a 4xx as hard',async()=>{
 const f=l4NativeFixture();f.env.ML_CONTROLLER_URL='https://controller.test';const original=globalThis.fetch
 try{
  globalThis.fetch=(async()=>new Response('',{status:502})) as typeof fetch
  await assert.rejects(singlePlanContext(f.env,'2026-09-14','2026-09-11'),/premarket_wait:controller_unavailable:.*HTTP 502/)
  globalThis.fetch=(async()=>new Response('',{status:403})) as typeof fetch
  await assert.rejects(singlePlanContext(f.env,'2026-09-14','2026-09-11'),/^Error: Controller \/pipeline\/v2\/premarket-state\?.* HTTP 403/)
 }finally{globalThis.fetch=original;f.close()}
})
test('controllerUnavailable classifies only transport and 5xx failures',()=>{
 assert.equal(controllerUnavailable(new Error('Controller /x HTTP 500: boom')),true)
 assert.equal(controllerUnavailable(new Error('Controller /x HTTP 404: missing')),false)
 assert.equal(controllerUnavailable(new Error('ML_CONTROLLER_URL not set')),false)
 assert.equal(controllerUnavailable(new TypeError('Cannot read properties of undefined')),false)
 assert.equal(controllerUnavailable(new Error('premarket_dispatch_receipt_invalid HTTP 500')),false)
 assert.equal(controllerUnavailable(new Error('Network connection lost.')),true,'workerd plain Error')
 assert.equal(controllerUnavailable(new Error('Controller /x HTTP 409: {"detail":"Network connection lost"}')),false,'status wins over body text')
})
