import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { queueFinLabCompletion, dispatchFinLabCompletion, runFinLabCompletionStage } from './finlabCompletionOutbox'
import { markPipelineStageFenced } from './pipelineStageLease'

async function fixture() {
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['OPS']})
 const db=await mf.getD1Database('OPS')
 await db.prepare(`CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT,
 processed_count INTEGER DEFAULT 0,expected_count INTEGER,persisted_count INTEGER DEFAULT 0,attempt_count INTEGER DEFAULT 0,
 lease_owner TEXT,lease_expires_at TEXT,queued_at TEXT,started_at TEXT,completed_at TEXT,last_error TEXT,updated_at TEXT,
 PRIMARY KEY(business_date,stage))`).run()
 const sent:any[]=[];let fail=false
 const env:any={DB:db,OPS_DB:db,UPDATE_QUEUE:{send:async(msg:any)=>{if(fail)throw new Error('send lost');sent.push(msg)}}}
 return {mf,db,sent,env,setFail:(v:boolean)=>{fail=v}}
}
const date='2026-10-01',run='finlab-v4-daily-20261001-original'

test('durable outbox survives lost send, duplicate callbacks and concurrent deliveries execute once',async()=>{
 const f=await fixture()
 try {
  f.setFail(true);await assert.rejects(()=>queueFinLabCompletion(f.env,date,run),/send lost/)
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM pipeline_stage_runs').first<any>())?.n,2)
  f.setFail(false);await dispatchFinLabCompletion(f.env,date)
  await queueFinLabCompletion(f.env,date,run);await queueFinLabCompletion(f.env,date,run)
  let work=0
  const msg=f.sent.find(m=>m.type==='finlab_backfill_complete')
  const execute=()=>runFinLabCompletionStage(f.env,msg,'finlab_market',async()=>{work++;await new Promise(r=>setTimeout(r,20));return 'ready'})
  await Promise.all([execute(),execute(),execute()]);assert.equal(work,1)
  await queueFinLabCompletion(f.env,date,run);await execute();assert.equal(work,1)
 } finally {await f.mf.dispose()}
})

test('expired lease recovers, old owner cannot finalize and permanent failures stop after three',async()=>{
 const f=await fixture()
 try {
  await queueFinLabCompletion(f.env,date,run)
  await f.db.prepare(`UPDATE pipeline_stage_runs SET status='running',lease_owner='dead',lease_expires_at='2000-01-01',attempt_count=1 WHERE stage='finlab_market'`).run()
  await dispatchFinLabCompletion(f.env,date)
  assert.equal(await markPipelineStageFenced(f.db as any,{businessDate:date,stage:'finlab_market',canonicalRunId:`${date}:finlab-completion-v1`,leaseOwner:'dead',status:'success'}),false)
  const msg=f.sent.find(m=>m.type==='finlab_backfill_complete');let calls=0
  for(let i=0;i<2;i++){
   await assert.rejects(()=>runFinLabCompletionStage(f.env,msg,'finlab_market',async()=>{calls++;throw new Error('failure')}),/failure/)
   await dispatchFinLabCompletion(f.env,date)
  }
  await assert.rejects(()=>runFinLabCompletionStage(f.env,msg,'finlab_market',async()=>{calls++;return 'ready'}),/retry_exhausted/)
  assert.equal(calls,2)
 }finally{await f.mf.dispose()}
})

test('sequence-only completion does not launch market work; dependency wait does not spend failure budget',async()=>{
 const f=await fixture()
 try{
  await queueFinLabCompletion(f.env,date,run,false,false)
  assert.deepEqual(f.sent.map(m=>m.type),['finlab_sequence_refresh'])
  const msg={type:'finlab_backfill_complete' as const,triggerTime:date,runId:run,cursor:0}
  await runFinLabCompletionStage(f.env,msg,'finlab_market',async()=> 'source waiting; queued retry')
  const row=await f.db.prepare("SELECT status,attempt_count FROM pipeline_stage_runs WHERE stage='finlab_market'").first<any>()
  assert.deepEqual(row,{status:'queued',attempt_count:0})
 }finally{await f.mf.dispose()}
})

test('explicit new force run can reopen a terminal stage, duplicate force and superseded messages cannot rerun it',async()=>{
 const f=await fixture()
 try{
  await queueFinLabCompletion(f.env,date,run)
  const old=f.sent.find(m=>m.type==='finlab_backfill_complete');let work=0
  await runFinLabCompletionStage(f.env,old,'finlab_market',async()=>{work++;return 'ready'})
  await queueFinLabCompletion(f.env,date,'forced-new',true)
  const msg=f.sent.filter(m=>m.type==='finlab_backfill_complete').at(-1)
  await runFinLabCompletionStage(f.env,old,'finlab_market',async()=>{throw new Error('stale delivery executed')})
  await runFinLabCompletionStage(f.env,msg,'finlab_market',async()=>{work++;return 'ready'})
  await queueFinLabCompletion(f.env,date,'forced-new',true)
  await runFinLabCompletionStage(f.env,msg,'finlab_market',async()=>{work++;return 'ready'})
  await runFinLabCompletionStage(f.env,{...old,force:true},'finlab_market',async()=>{throw new Error('stale force replay executed')})
  assert.equal(work,2)
 }finally{await f.mf.dispose()}
})
