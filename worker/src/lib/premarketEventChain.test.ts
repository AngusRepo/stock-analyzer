import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { ensurePremarketEventChain, processPremarketEvent, type PremarketWork } from './premarketEventChain'
import type { UpdateQueueMsg } from '../types'
const date='2026-09-14'
function fixture() {
 const f=l4NativeFixture(), messages:UpdateQueueMsg[]=[], delays:number[]=[]
 f.env.UPDATE_QUEUE={send:async(msg:UpdateQueueMsg,o:any)=>{messages.push(msg);delays.push(o?.delaySeconds ?? 0)}}
 return {...f,messages,delays,now:()=>f.ports.nowMs, rows:()=>f.sqls.ops.prepare("SELECT stage,status,attempt_count FROM pipeline_stage_runs WHERE stage LIKE 'premarket_v3:%' ORDER BY rowid").all() as any[]}
}
const stages=['context','setup','debate:0','replan:0','publish:0'] as const
test('atomic chain deduplicates signals and simultaneous deliveries',async()=>{
 const f=fixture(), ran:string[]=[]
 const work:PremarketWork=async(stage,input,guard)=>{await guard();ran.push(stage);return {next:stages[stages.indexOf(stage as any)+1] ?? null,receipt:{...input,ready:stage==='publish:0'}}}
 try {
  await ensurePremarketEventChain(f.env,date,f.now());await ensurePremarketEventChain(f.env,date,f.now())
  for(let n=0;f.messages.length && n<30;n++){const msg=f.messages.shift()!;await Promise.all([processPremarketEvent(f.env,msg,work,f.now()),processPremarketEvent(f.env,msg,work,f.now())])}
  assert.deepEqual(ran,stages);assert.ok(f.rows().every(r=>r.status==='success'))
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=success/)
  assert.equal(JSON.parse(f.kvs.get(`scheduler:run:morning-setup:${date}`)!).status,'success')
  assert.equal(JSON.parse(f.kvs.get(`scheduler:run:pre-market-warmup:${date}`)!).status,'success')
 }finally{f.close()}
})
test('published daily head stays ready if later advisory debate fails',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 const work:PremarketWork=async(stage)=>{
   if(stage==='context')return {next:'publish:0',receipt:{}}
   if(stage==='publish:0')return {next:'debate:0',receipt:{ready:true}}
   throw new Error('observer offline')
 }
 try{
   await ensurePremarketEventChain(f.env,date,f.now())
   await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
   await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
   assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=success/)
   for(let attempt=0;attempt<3;attempt++){
     await assert.rejects(processPremarketEvent(f.env,f.messages.shift()!,work,f.now()),/observer offline/)
     f.ports.nowMs+=121_000
   }
   assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=success/)
   assert.equal(JSON.parse(f.kvs.get(`scheduler:run:pre-market-warmup:${date}`)!).status,'success')
 }finally{f.close()}
})
test('lost queue send recovers committed successor without repeating producer',async()=>{
 const f=fixture();let calls=0
 const work:PremarketWork=async()=>{calls++;return {next:'setup',receipt:{}}}
 try{
  await ensurePremarketEventChain(f.env,date,f.now());const msg=f.messages.shift()!,send=f.env.UPDATE_QUEUE.send
  f.env.UPDATE_QUEUE.send=async()=>{throw new Error('queue unavailable')}
  await assert.rejects(processPremarketEvent(f.env,msg,work,f.now()),/queue unavailable/)
  assert.deepEqual(f.rows().map(r=>r.status),['success','queued'])
  f.env.UPDATE_QUEUE.send=send;await ensurePremarketEventChain(f.env,date,f.now())
  await processPremarketEvent(f.env,msg,work,f.now());assert.equal(calls,1);assert.equal(f.messages.at(-1)?.premarketStage,'setup')
 }finally{f.close()}
})
test('D1 transaction failure rolls back completion and successor',async()=>{
 const f=fixture()
 try{
  await ensurePremarketEventChain(f.env,date,f.now());const batch=f.env.OPS_DB.batch
  f.env.OPS_DB.batch=(ss:any[])=>batch([ss[0],f.env.OPS_DB.prepare('INSERT INTO missing_table VALUES (1)')])
  await assert.rejects(processPremarketEvent(f.env,f.messages[0],async()=>({next:'setup',receipt:{}}),f.now()),/missing_table/)
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].status,'waiting')
 }finally{f.close()}
})
test('expired owner cannot commit after watchdog reclaims lease',async()=>{
 const f=fixture()
 try{
  await ensurePremarketEventChain(f.env,date,f.now())
  await assert.rejects(processPremarketEvent(f.env,f.messages[0],async()=>{f.ports.nowMs+=601_000;await ensurePremarketEventChain(f.env,date,f.now());return {next:'setup',receipt:{}}},f.now()),/lease_lost/)
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].status,'queued')
 }finally{f.close()}
})
test('three real failures are terminal; recovery does not reset budget',async()=>{
 const f=fixture();let calls=0
 try{
  for(let i=0;i<4;i++){await ensurePremarketEventChain(f.env,date,f.now());if(i<3)await assert.rejects(processPremarketEvent(f.env,f.messages.at(-1)!,async()=>{calls++;throw new Error('provider failed')},f.now()),/provider failed/);f.ports.nowMs+=121_000}
  assert.equal(calls,3);assert.equal(f.rows()[0].status,'error')
 }finally{f.close()}
})
test('dependency wait preserves compute budget; target breach is visible',async()=>{
 const f=fixture()
 try{
  await ensurePremarketEventChain(f.env,date,f.now())
  await assert.rejects(processPremarketEvent(f.env,f.messages[0],async()=>{throw new Error('premarket_wait:evening_pipeline')},f.now()),/premarket_wait/)
  assert.equal(f.rows()[0].attempt_count,0);f.ports.nowMs=Date.parse(date+'T00:45:00Z')
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/overdue=true/)
 }finally{f.close()}
})
test('business clock gates early messages and rejects yesterday delivery',async()=>{
 const f=fixture();let calls=0
 try{
  f.ports.nowMs=Date.parse(date+'T06:35:00+08:00');await ensurePremarketEventChain(f.env,date,f.now());assert.equal(f.delays[0],600)
  const msg=f.messages[0],work:PremarketWork=async()=>{calls++;return {next:null,receipt:{}}}
  await processPremarketEvent(f.env,msg,work,f.now());assert.equal(calls,0)
  f.ports.nowMs+=86400_000;await processPremarketEvent(f.env,msg,work,f.now());assert.equal(calls,0);assert.equal(f.rows()[0].status,'error')
 }finally{f.close()}
})

test('dependency retries advance from delayed queue without waiting for watchdog cron',async()=>{
 const f=fixture();let calls=0
 try{
  await ensurePremarketEventChain(f.env,date,f.now());const msg=f.messages.shift()!
  const work:PremarketWork=async()=>{if(++calls===1)throw new Error('premarket_wait:source');return {next:'setup',receipt:{}}}
  await assert.rejects(processPremarketEvent(f.env,msg,work,f.now()),/premarket_wait/)
  assert.equal(f.delays.at(-1),120);f.ports.nowMs+=121_000
  await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
  assert.equal(calls,2);assert.deepEqual(f.rows().map(r=>r.status),['success','queued'])
 }finally{f.close()}
})
test('holiday wake does not create or dispatch a daily chain',async()=>{
 const f=fixture()
 try{f.kvs.set(`holiday:${date}`,'1');assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/non_trading_day/);assert.equal(f.rows().length,0);assert.equal(f.messages.length,0)}finally{f.close()}
})

test('single-plan mode accepts 08:44:59 and expires at 08:45 without doing more work',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';let calls=0
 try{
  f.ports.nowMs=Date.parse(date+'T08:44:59+08:00')
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/queued=1/)
  f.ports.nowMs+=1000
  await processPremarketEvent(f.env,f.messages[0],async()=>{calls++;return {next:null,receipt:{}}},f.now())
  assert.equal(calls,0);assert.equal(f.rows()[0].status,'error')
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/outside_window/)
 }finally{f.close()}
})

test('published plan permits advisory debate after the 08:45 publication cutoff',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';const ran:string[]=[]
 const work:PremarketWork=async(stage)=>{
   ran.push(stage)
   return stage==='context' ? {next:'publish:0',receipt:{}}
     : stage==='publish:0' ? {next:'debate:0',receipt:{ready:true}}
     : {next:null,receipt:{advisory_debate:'observed'}}
 }
 try{
   f.ports.nowMs=Date.parse(date+'T08:44:59+08:00')
   await ensurePremarketEventChain(f.env,date,f.now())
   await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
   await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
   f.ports.nowMs+=1000
   await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
   assert.deepEqual(ran,['context','publish:0','debate:0'])
   assert.ok(f.rows().every(row=>row.status==='success'))
   assert.equal(JSON.parse(f.kvs.get(`scheduler:run:pre-market-warmup:${date}`)!).status,'success')
 }finally{f.close()}
})
