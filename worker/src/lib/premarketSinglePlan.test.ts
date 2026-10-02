import assert from 'node:assert/strict'
import test from 'node:test'
import {premarketWork} from './premarketEventWork'
import type {PremarketStage,PremarketPayload} from './premarketEventChain'
test('morning execution traverses one allocation and one debate; never full replan',async()=>{
 const calls:string[]=[];const id='a'.repeat(64)
 const work=premarketWork({PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any,'2026-10-02',{
   warmup:async()=>{calls.push('warmup')},ensurePaperCorporateSource:async()=>{},settle:async()=>{calls.push('settle')},
   dispatchSinglePlan:async()=>{calls.push('allocate');return id},
   recoverPaperMorningSetup:async()=>{calls.push('pending');return 'ready'},
   reconcilePendingBuyDebates:async()=>{calls.push('debate');return 'status=success'},
   loadPendingBuySnapshot:async()=>({pendingBuys:[],meta:{status:'empty'}} as any),
   readL4PortfolioPlan:async()=>({plan_id:id} as any),
   flushL4Replans:async()=>{throw new Error('optimizer must not be invoked')},
   contextIdentity:async()=>{throw new Error('sealed context cannot be refreshed')},
   finalizeSinglePlan:async(_e,_d,input)=>{calls.push('publish');return {...input,ready:true,plan_id:id,review_checksum:'f'.repeat(64),pending_run_id:1,pending_status:'ready',symbols:[]}},
 })
 let stage:PremarketStage|null='setup',input:PremarketPayload={context_hash:'f'.repeat(64),signal_date:'2026-10-01'}
 while(stage){const r=await work(stage,input,async()=>{});stage=r.next;input=r.receipt}
 assert.deepEqual(calls,['warmup','settle','allocate','pending','debate','publish']);assert.equal(input.ready,true)
})
