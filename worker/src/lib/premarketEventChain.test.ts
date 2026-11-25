import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import fs from 'node:fs'
import { ensurePremarketEventChain, premarketCauseText, premarketPublicationDisplayMeta, processPremarketEvent, projectExpiredRunHistory, type PremarketWork } from './premarketEventChain'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'
import { formatPendingBuyBriefing } from './pendingBuyBriefingSummary'
import type { UpdateQueueMsg } from '../types'
const date='2026-09-14'
function fixture() {
 const f=l4NativeFixture(), messages:UpdateQueueMsg[]=[], delays:number[]=[]
 f.env.UPDATE_QUEUE={send:async(msg:UpdateQueueMsg,o:any)=>{messages.push(msg);delays.push(o?.delaySeconds ?? 0)}}
 // Trading-day owner reads TWSE feeds; keep them offline and announcing nothing.
 globalThis.fetch=(async(url:string)=>({ok:true,status:200,json:async()=>String(url).includes('newsList')?[{Title:'unrelated'}]:[]})) as typeof fetch
 return {...f,messages,delays,now:()=>f.ports.nowMs, rows:()=>f.sqls.ops.prepare("SELECT stage,status,attempt_count FROM pipeline_stage_runs WHERE stage LIKE 'premarket_v3:%' ORDER BY rowid").all() as any[]}
}
const stages=['context','setup','debate:0','replan:0','publish:0'] as const
for (const recoveryDate of ['2026-10-12','2026-10-14','2026-10-16','2026-10-21']) test(`${recoveryDate} paper recovery dispatches after 09:00 and expires at day end`,async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';let calls=0
 try{
  f.ports.nowMs=Date.parse(`${recoveryDate}T09:00:00+08:00`)
  assert.match(await ensurePremarketEventChain(f.env,recoveryDate,f.now()),/ready_target=24:00 overdue=false/)
  const msg=f.messages.shift()!
  await processPremarketEvent(f.env,msg,async()=>{calls++;return {next:'setup',receipt:{}}},f.now())
  assert.equal(calls,1)
  f.ports.nowMs=Date.parse(`${recoveryDate}T24:00:00+08:00`)
  await processPremarketEvent(f.env,f.messages.shift()!,async()=>{calls++;return {next:null,receipt:{}}},f.now())
  assert.equal(calls,1)
  assert.match(await ensurePremarketEventChain(f.env,recoveryDate,f.now()),/outside_window/)
 }finally{f.close()}
})

for(const scenario of ['repaired','wrong_context','live_enabled','fourth_failure','retry_failed'])test(`Oct 21 exact Paper publication continuation preserves attempts: ${scenario}`,async()=>{
 const f=fixture(),day='2026-10-21';let calls=0
 f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';f.env.LIVE_EXECUTION_CLIENT_ENABLED='0'
 f.env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=scenario==='live_enabled'?'1':'0'
 f.ports.nowMs=Date.parse(day+'T10:00:00+08:00')
 const cursor=JSON.stringify({signal_date:'2026-10-20',morning_context:{trade_date:day,
  checksum:scenario==='wrong_context'?'wrong':'d5b866e6f694a4b461e02cb54ee058f1ba7bc63e9b04fd5504c15be95b0e7213'},
  l3_receipt:{run_id:'pipeline-dispatch:2026-10-20:270320c4-8d25-4187-aec2-79595289d428',checksum:'9e36664032344abc96ebfa0ffa39dcc95c59516aad06a5ec5f41423a6efc01f8'}})
 const attempts=scenario==='fourth_failure'?4:3,error='Error: paper_morning_recovery_setup_not_materialized'
 try{
  f.sqls.ops.prepare('INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)')
   .run(day,'premarket_v3:allocate',day+':premarket-v3','error',cursor,attempts,error)
  await ensurePremarketEventChain(f.env,day,f.now())
  const before=f.sqls.ops.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='premarket_v3:allocate'").get() as any
  const allowed=scenario==='repaired'||scenario==='retry_failed'
  assert.equal(before.status,allowed?'queued':'error');assert.equal(before.attempt_count,attempts)
  assert.equal(before.cursor_key,cursor);assert.equal(before.last_error,error)
  if(allowed){
   const msg={type:'premarket_stage',cursor:0,triggerTime:day,runId:day+':premarket-v3',premarketStage:'allocate'} as UpdateQueueMsg
   const work:PremarketWork=async()=>{calls++;if(scenario==='retry_failed')throw new Error('repair_failed');return {next:null,receipt:{ready:true}}}
   if(scenario==='retry_failed')await assert.rejects(processPremarketEvent(f.env,msg,work,f.now()),/repair_failed/)
   else await processPremarketEvent(f.env,msg,work,f.now())
   await ensurePremarketEventChain(f.env,day,f.now());await processPremarketEvent(f.env,msg,work,f.now())
   const after=f.sqls.ops.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='premarket_v3:allocate'").get() as any
   assert.equal(calls,1);assert.equal(after.attempt_count,4);assert.equal(after.status,scenario==='retry_failed'?'error':'success')
  }
 }finally{f.close()}
})
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
  // FG-10 U17: the expired chain is reported overdue (not a neutral skip) and nothing is redispatched.
  const sent=f.messages.length
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=error premarket_event_chain overdue=true/)
  assert.equal(f.messages.length,sent)
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


test('setup commits allocation and delayed market health in the same transaction',async()=>{
 const f=fixture()
 const work:PremarketWork=async(stage)=>stage==='context'?{next:'setup',receipt:{}}:{next:'allocate',followups:['market-health'],receipt:{}}
 try{
  await ensurePremarketEventChain(f.env,date,f.now())
  await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
  await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
  assert.deepEqual(f.rows().filter(r=>r.status==='queued').map(r=>r.stage).sort(),['premarket_v3:allocate','premarket_v3:market-health'])
  assert(f.messages.some(m=>m.premarketStage==='market-health'))
 }finally{f.close()}
})


test('published plan does not hide a terminal broker health failure',async()=>{
 const f=fixture()
 try {
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key) VALUES (?,?,?,? ,?)").run(date,'premarket_v3:publish:0',`${date}:premarket-v3`,'success',JSON.stringify({output:{ready:true}}))
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key) VALUES (?,?,?,? ,?)").run(date,'premarket_v3:market-health',`${date}:premarket-v3`,'error','{}')
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=error/)
  const receipt=JSON.parse(f.kvs.get(`scheduler:run:pre-market-warmup:${date}`)!)
  assert.equal(receipt.status,'error');assert.match(receipt.summary,/market-health.*plan_published=true/)
 } finally {f.close()}
})

for (const day of ['2026-10-12','2026-10-13','2026-10-16']) for (const fail of [false,true]) test(`${day} setup allows one preserved fourth attempt; fail=${fail}`,async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 f.env.LIVE_EXECUTION_CLIENT_ENABLED='0';f.env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED='0'
 f.ports.nowMs=Date.parse(day+'T16:00:00+08:00');let calls=0
 try {
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count) VALUES(?,?,?,?,?,?)")
    .run(day,'premarket_v3:setup',day+':premarket-v3','queued','{}',3)
  const msg={type:'premarket_stage',cursor:0,triggerTime:day,runId:day+':premarket-v3',premarketStage:'setup'} as UpdateQueueMsg
  const work:PremarketWork=async()=>{calls++;if(fail)throw new Error('recovery_failed');return {next:null,receipt:{}}}
  if(fail)await assert.rejects(processPremarketEvent(f.env,msg,work,f.now()),/recovery_failed/)
  else await processPremarketEvent(f.env,msg,work,f.now())
  assert.equal(f.rows()[0].attempt_count,4)
  assert.equal(f.rows()[0].status,fail?'error':'success')
  await processPremarketEvent(f.env,msg,work,f.now());assert.equal(calls,1)
 }finally{f.close()}
})

for (const scenario of ['repaired','other_error','fourth_failure','live_enabled']) test(`October 16 recovery preserves failed attempt evidence and only requeues repaired setup: ${scenario}`,async()=>{
 const f=fixture();const day='2026-10-16'
 f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';f.env.LIVE_EXECUTION_CLIENT_ENABLED='0'
 f.env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=scenario==='live_enabled'?'1':'0'
 f.ports.nowMs=Date.parse(day+'T12:50:00+08:00')
 const reason=scenario==='other_error'?'unrelated_fault':'Error: corporate_source_live_preopen_required'
 const attempts=scenario==='fourth_failure'?4:3
 const cursor=JSON.stringify({signal_date:'2026-10-15',context_hash:'preserved'})
 try {
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
   .run(day,'premarket_v3:setup',day+':premarket-v3','error',cursor,attempts,reason)
  await ensurePremarketEventChain(f.env,day,f.now())
  const row=f.rows().find(r=>r.stage==='premarket_v3:setup')!
  assert.equal(row.status,scenario==='repaired'?'queued':'error')
  assert.equal(row.attempt_count,attempts)
  const saved=f.sqls.ops.prepare("SELECT last_error,cursor_key FROM pipeline_stage_runs WHERE stage='premarket_v3:setup'").get() as {last_error:string;cursor_key:string}
  assert.equal(saved.cursor_key,cursor)
  assert.equal(saved.last_error,reason)
 } finally {f.close()}
})
for(const scenario of ['repaired','other_parent_error','fourth_failure','live_enabled','wrong_lineage'])test(`historical allocation continuation preserves evidence and is bounded: ${scenario}`,async()=>{
 const f=fixture(),day='2026-10-16',run='sealed-run'
 f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';f.env.LIVE_EXECUTION_CLIENT_ENABLED='0'
 f.env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=scenario==='live_enabled'?'1':'0'
 f.ports.nowMs=Date.parse(day+'T14:30:00+08:00')
 const error='Error: Controller /pipeline/v2/premarket-resume HTTP 500: Internal Server Error'
 const upstream=scenario==='other_parent_error'?'d1_write:failed':'paired_nav:atomic_collection:historical_not_prospective; paired_nav:atomic_daily:requires_allocation_and_native_execution; paired_nav:atomic_candidate_setup:paired_nav_atomic_no_executable_plans'
 const cursor=JSON.stringify({signal_date:'2026-10-15',morning_context:{trade_date:day},l3_receipt:{run_id:scenario==='wrong_lineage'?'other':run}})
 const attempts=scenario==='fourth_failure'?4:3
 try{
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
   .run('2026-10-15','pipeline_execution',run,'error','{}',1,upstream)
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
   .run(day,'premarket_v3:allocate',day+':premarket-v3','error',cursor,attempts,error)
  await ensurePremarketEventChain(f.env,day,f.now())
  const before=f.sqls.ops.prepare("SELECT * FROM pipeline_stage_runs WHERE business_date=? AND stage='premarket_v3:allocate'").get(day) as any
  assert.equal(before.status,scenario==='repaired'?'queued':'error');assert.equal(before.attempt_count,attempts)
  assert.equal(before.cursor_key,cursor);assert.equal(before.last_error,error)
  if(scenario==='repaired'){
   let calls=0;const msg={type:'premarket_stage',cursor:0,triggerTime:day,runId:day+':premarket-v3',premarketStage:'allocate'} as UpdateQueueMsg
   await processPremarketEvent(f.env,msg,async()=>{calls++;return {next:null,receipt:{verified:true}}},f.now())
   await processPremarketEvent(f.env,msg,async()=>{calls++;throw new Error('duplicate')},f.now())
   const after=f.sqls.ops.prepare("SELECT status,attempt_count FROM pipeline_stage_runs WHERE business_date=? AND stage='premarket_v3:allocate'").get(day) as any
   assert.equal(calls,1);assert.equal(after.status,'success');assert.equal(after.attempt_count,4)
  }
 }finally{f.close()}
})
for(const success of [true,false])test(`publication retry requires actual reconciled pipeline success: ${success}`,async()=>{
 const f=fixture(),day='2026-10-16',run='sealed-root';f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 f.env.LIVE_EXECUTION_CLIENT_ENABLED='0';f.env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED='0'
 f.ports.nowMs=Date.parse(day+'T16:00:00+08:00')
 try{
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count) VALUES(?,?,?,?,?,?)")
   .run('2026-10-15','pipeline_execution',run,success?'success':'error','{}',2)
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
   .run(day,'premarket_v3:allocate',day+':premarket-v3','error',JSON.stringify({signal_date:'2026-10-15',morning_context:{trade_date:day},l3_receipt:{run_id:run}}),4,'Error: paper_morning_recovery_setup_not_materialized')
  await ensurePremarketEventChain(f.env,day,f.now())
  const row=f.sqls.ops.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='premarket_v3:allocate'").get() as any
  assert.equal(row.status,success?'queued':'error');assert.equal(row.attempt_count,4)
  if(success){
   const msg={type:'premarket_stage',cursor:0,triggerTime:day,runId:day+':premarket-v3',premarketStage:'allocate'} as UpdateQueueMsg
   let calls=0
   const work:PremarketWork=async()=>{calls++;return {next:null,receipt:{ready:true}}}
   await processPremarketEvent(f.env,msg,work,f.now());await processPremarketEvent(f.env,msg,work,f.now())
   const done=f.sqls.ops.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='premarket_v3:allocate'").get() as any
   assert.equal(calls,1);assert.equal(done.status,'success');assert.equal(done.attempt_count,5)
  }
 }finally{f.close()}
})
test('typhoon closure announced after the chain is queued stops every stage',async()=>{
 const f=fixture(),day='2026-10-23';let calls=0
 const closure={Title:'臺灣證券交易所集中交易市場115年10月23日休市一天',Url:'u',Date:'1151022'}
 try{
  f.ports.nowMs=Date.parse(day+'T06:50:00+08:00')
  await ensurePremarketEventChain(f.env,day,f.now())
  const msg=f.messages.shift()!
  globalThis.fetch=(async(url:string)=>({ok:true,status:200,json:async()=>String(url).includes('newsList')?[closure]:[]})) as typeof fetch
  f.kvs.delete(`market:twse_adhoc_closure_check:v1:${day}`)
  await processPremarketEvent(f.env,msg,async()=>{calls++;return {next:'setup',receipt:{}}},f.now())
  assert.equal(calls,0)
  const row=f.sqls.ops.prepare("SELECT status,last_error,attempt_count FROM pipeline_stage_runs WHERE stage='premarket_v3:context'").get() as any
  assert.equal(row.status,'error');assert.equal(row.last_error,'premarket_non_trading_day:twse_adhoc_closure');assert.equal(row.attempt_count,0)
  assert.match(String(f.kvs.get(`holiday:${day}`)),/115年10月23日休市/)
  assert.match(await ensurePremarketEventChain(f.env,day,f.now()),/status=skipped premarket_non_trading_day reason=twse_adhoc_closure/)
  assert.equal(f.kvs.get(`scheduler:run:morning-setup:${day}`),undefined)
 }finally{f.close()}
})
test('U17: after the publication target an unfinished chain is overdue, not a neutral skip',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 const work:PremarketWork=async(stage)=>({next:stage==='context'?'publish:0':null,receipt:{ready:stage==='publish:0'}})
 try{
  f.ports.nowMs=Date.parse(`${date}T08:00:00+08:00`)
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=pending/)
  f.ports.nowMs=Date.parse(`${date}T08:50:00+08:00`)
  const overdue=await ensurePremarketEventChain(f.env,date,f.now())
  assert.match(overdue,/^status=error premarket_event_chain overdue=true ready_target=08:45 stage=premarket_v3:context/)
  assert.equal(f.messages.length,1,'reporting overdue dispatches nothing new')
  f.ports.nowMs=Date.parse(`${date}T08:00:00+08:00`)
  await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
  await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
  f.ports.nowMs=Date.parse(`${date}T08:50:00+08:00`)
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/status=skipped premarket_outside_window/,'a published plan stays a quiet skip')
 }finally{f.close()}
})

// 11/5, 11/16, 11/20: the chain expired with no pending_buy_runs row and the real blocker overwritten.
const pendingRuns=(f:ReturnType<typeof fixture>)=>f.sqls.paper.prepare('SELECT trade_date,source_reco_date,status,debate_status,candidate_count,error_message FROM pending_buy_runs ORDER BY id').all() as any[]
const lastError=(f:ReturnType<typeof fixture>,stage:string)=>(f.sqls.ops.prepare('SELECT last_error FROM pipeline_stage_runs WHERE stage=?').get('premarket_v3:'+stage) as any)?.last_error
test('expiry keeps the blocking cause and records one explicit no-decision run',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 try{
  f.ports.nowMs=Date.parse(date+'T07:00:00+08:00')
  await ensurePremarketEventChain(f.env,date,f.now())
  const msg=f.messages.shift()!
  await assert.rejects(processPremarketEvent(f.env,msg,async()=>{throw new Error('premarket_wait:l3_source')},f.now()),/l3_source/)
  f.ports.nowMs=Date.parse(date+'T08:46:00+08:00')
  await processPremarketEvent(f.env,msg,async()=>{throw new Error('must not run')},f.now())
  assert.equal(lastError(f,'context'),'premarket_session_expired:Error: premarket_wait:l3_source')
  // A second late delivery neither nests the prefix nor adds a run.
  await processPremarketEvent(f.env,msg,async()=>{throw new Error('must not run')},f.now())
  assert.equal(lastError(f,'context'),'premarket_session_expired:Error: premarket_wait:l3_source')
  f.ports.nowMs=Date.parse(date+'T08:50:00+08:00')
  const summary=await ensurePremarketEventChain(f.env,date,f.now())
  assert.match(summary,/^status=error premarket_event_chain overdue=true ready_target=08:45 stage=premarket_v3:context no_decision_record=existing_decision cause=premarket_session_expired:Error: premarket_wait:l3_source$/)
  const runs=pendingRuns(f)
  assert.equal(runs.length,1)
  assert.deepEqual({...runs[0]},{trade_date:date,source_reco_date:null,status:'error',debate_status:'skipped',candidate_count:0,
   error_message:'premarket_no_decision:context:premarket_session_expired:Error: premarket_wait:l3_source'})
 }finally{f.close()}
})
test('overdue sweep records the terminal controller failure (11/16 shape)',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 try{
  const insert=f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
  insert.run(date,'premarket_v3:context',date+':premarket-v3','success',JSON.stringify({input:{},output:{signal_date:'2026-09-11'}}),1,null)
  insert.run(date,'premarket_v3:market-health',date+':premarket-v3','success','{}',1,null)
  insert.run(date,'premarket_v3:allocate',date+':premarket-v3','error',JSON.stringify({signal_date:'2026-09-11',l3_receipt:{run_id:'r'}}),3,
   'Error: Controller /pipeline/v2/premarket-resume HTTP 500: Internal Server Error')
  f.ports.nowMs=Date.parse(date+'T08:50:00+08:00')
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/stage=premarket_v3:allocate no_decision_record=recorded cause=Error: Controller \/pipeline\/v2\/premarket-resume HTTP 500/)
  assert.match(await ensurePremarketEventChain(f.env,date,f.now()),/no_decision_record=existing_decision/)
  const runs=pendingRuns(f)
  // No recommendation date was consumed; the data-quality date check fails this run on its status.
  assert.equal(runs.length,1);assert.equal(runs[0].status,'error');assert.equal(runs[0].source_reco_date,null)
  assert.equal(runs[0].error_message,'premarket_no_decision:allocate:Error: Controller /pipeline/v2/premarket-resume HTTP 500: Internal Server Error')
 }finally{f.close()}
})
for(const scenario of ['existing_ready','published','holiday','not_started'])test(`no-decision record never replaces a decision or marks a closed day: ${scenario}`,async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 try{
  if(scenario==='existing_ready')f.sqls.paper.prepare("INSERT INTO pending_buy_runs(trade_date,status,debate_status,candidate_count) VALUES(?,?,?,?)").run(date,'ready','pending',2)
  if(scenario==='published')f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key) VALUES (?,?,?,?,?)").run(date,'premarket_v3:publish:0',date+':premarket-v3','success',JSON.stringify({output:{ready:true}}))
  if(scenario==='holiday')f.kvs.set(`holiday:${date}`,'1')
  f.ports.nowMs=Date.parse(date+'T08:50:00+08:00')
  const summary=await ensurePremarketEventChain(f.env,date,f.now())
  const runs=pendingRuns(f)
  if(scenario==='not_started'){
   assert.match(summary,/stage=not_started no_decision_record=recorded cause=not_started$/)
   assert.equal(runs.length,1);assert.equal(runs[0].error_message,'premarket_no_decision:not_started')
  } else if(scenario==='existing_ready'){
   assert.match(summary,/no_decision_record=existing_decision/)
   assert.deepEqual(runs.map(r=>r.status),['ready'])
  } else {
   assert.match(summary,/status=skipped/);assert.equal(runs.length,0)
  }
 }finally{f.close()}
})
test('an unavailable controller backs off (bounded) without burning attempts, then expires with its cause',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';let calls=0
 const work:PremarketWork=async()=>{calls++;throw new Error('premarket_wait:controller_unavailable:Controller /pipeline/v2/premarket-resume HTTP 500: Internal Server Error')}
 try{
  f.ports.nowMs=Date.parse(date+'T07:20:00+08:00')
  await ensurePremarketEventChain(f.env,date,f.now())
  let msg=f.messages.shift()!
  const delays:number[]=[]
  for(let i=0;i<5;i++){
   await assert.rejects(processPremarketEvent(f.env,msg,work,f.now()),/controller_unavailable/)
   delays.push(f.delays.at(-1)!);msg=f.messages.shift()!
   // An early redelivery inside the backoff lease is not claimed.
   await processPremarketEvent(f.env,msg,work,f.now());assert.equal(calls,i+1)
   f.ports.nowMs+=delays.at(-1)!*1000+1000
  }
  assert.deepEqual(delays,[120,240,480,600,600])
  const row=f.sqls.ops.prepare("SELECT status,attempt_count,last_error FROM pipeline_stage_runs WHERE stage='premarket_v3:context'").get() as any
  assert.equal(row.status,'waiting');assert.equal(row.attempt_count,0);assert.match(row.last_error,/^backoff_streak=5 Error: premarket_wait:controller_unavailable:/)
  // A different wait returns to the normal dependency cadence.
  await assert.rejects(processPremarketEvent(f.env,msg,async()=>{throw new Error('premarket_wait:l3_seal')},f.now()),/l3_seal/)
  assert.equal(f.delays.at(-1),120)
  f.ports.nowMs=Date.parse(date+'T08:45:00+08:00')
  await processPremarketEvent(f.env,f.messages.shift()!,work,f.now())
  assert.equal(lastError(f,'context'),'premarket_session_expired:Error: premarket_wait:l3_seal')
  assert.equal(pendingRuns(f).length,1)
 }finally{f.close()}
})
test('controller backoff is clamped to leave a retry before the 08:45 deadline',async()=>{
 const f=fixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 const work:PremarketWork=async()=>{throw new Error('premarket_wait:controller_unavailable:Controller /x HTTP 503: ')}
 try{
  f.ports.nowMs=Date.parse(date+'T08:41:00+08:00')
  await ensurePremarketEventChain(f.env,date,f.now())
  f.sqls.ops.prepare("UPDATE pipeline_stage_runs SET last_error=? WHERE stage='premarket_v3:context'")
   .run('backoff_streak=4 Error: premarket_wait:controller_unavailable:Controller /x HTTP 503: ')
  await assert.rejects(processPremarketEvent(f.env,f.messages.shift()!,work,f.now()),/controller_unavailable/)
  assert.equal(f.delays.at(-1),180,'streak 5 would wait 600s; 08:41 leaves 240s minus a 60s margin')
  f.ports.nowMs=Date.parse(date+'T08:44:40+08:00')
  await assert.rejects(processPremarketEvent(f.env,f.messages.shift()!,work,f.now()),/controller_unavailable/)
  assert.equal(f.delays.at(-1),30,'floor of 30s; the next delivery expires the stage with its cause')
 }finally{f.close()}
})
test('premarketCauseText is bounded and drops credentials',()=>{
 const text=premarketCauseText('Error: token=abc123 Authorization: Bearer xyz /x?key=s3cret&b=2 '+'z'.repeat(500))
 assert.ok(text.length<=300)
 assert.doesNotMatch(text,/abc123|xyz|s3cret/)
 assert.match(text,/token=\[redacted\]/)
})

// Allocate finishing after 08:45 writes a ready run that trading never acts on (no finalized head).
function withDailyPlanHeads(f:ReturnType<typeof fixture>){
 f.sqls.paper.exec(fs.readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
 f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
}
const readyMeta={run_id:7,status:'ready',candidate_count:2,error_message:undefined}
test('an unpublished ready run past the deadline displays as a failed flow with its reason',async()=>{
 const f=fixture();withDailyPlanHeads(f)
 try{
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
   .run(date,'premarket_v3:publish:0',date+':premarket-v3','error','{}',1,'premarket_session_expired')
  const late=Date.parse(date+'T09:30:00+08:00')
  const meta=await premarketPublicationDisplayMeta(f.env,date,readyMeta,late)
  assert.deepEqual(meta,{...readyMeta,status:'error',original_status:'ready',original_error_message:undefined,publication_state:'expired',
   error_message:'premarket_publication_expired:publish:0:premarket_session_expired'})
  const summary=buildPendingBuyStateSummary([],meta as any)
  assert.equal(summary.state,'error');assert.equal(summary.label,'流程失敗');assert.match(String(summary.error_message),/premarket_publication_expired/)
  const history=projectExpiredRunHistory({runs:[{run_id:7,status:'ready'},{run_id:6,status:'empty'}]},7,meta)
  assert.deepEqual(history.runs.map(r=>r.status),['error','empty'])
  // Before the deadline the same run is still a normal pending publication.
  assert.equal(await premarketPublicationDisplayMeta(f.env,date,readyMeta,Date.parse(date+'T08:30:00+08:00')),readyMeta)
  // Display projection writes nothing.
  assert.equal((f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM pending_buy_runs').get() as any).n,0)
 }finally{f.close()}
})
test('dashboard route and daily report read pending state through the publication projection',()=>{
 const route=fs.readFileSync(new URL('../routes/paper.ts',import.meta.url),'utf8')
 assert.match(route,/let displayMeta = await reconcileLegacyP6DisplayMeta\(c\.env, snapshot\.date, snapshot\.meta as Record<string, any> \| null\)\n[^\n]*\n\s+displayMeta = await premarketPublicationDisplayMeta\(c\.env, snapshot\.date, displayMeta\)\n\s+const state = /)
 assert.match(route,/runHistory: projectExpiredRunHistory\(stripLegacyPendingBuyRunHistory\(runHistory\), snapshot\.meta\?\.run_id, displayMeta\)/)
 assert.match(route,/const state = buildPendingBuyStateSummary\(snapshot\.pendingBuys, displayMeta\)/)
 const report=fs.readFileSync(new URL('./dailyReport.ts',import.meta.url),'utf8')
 assert.match(report,/buildPendingBuyStateSummary\(pendingSnapshot\.pendingBuys,\s+await premarketPublicationDisplayMeta\(env, reportDate, pendingSnapshot\.meta\)\)/)
})
for(const scenario of ['halted_with_reason','other_day_head','no_chain','health_only_error'])test(`publication display reason and scope: ${scenario}`,async()=>{
 const f=fixture();withDailyPlanHeads(f)
 try{
  const insert=f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
  if(scenario==='other_day_head'){
   // A head for another trade date (or account) does not finalize today.
   f.sqls.paper.prepare('INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,revision,payload_json) VALUES(?,?,?,?,0,?)').run(1,'2026-09-11','c','p','{}')
   f.sqls.paper.prepare('INSERT INTO paper_daily_plan_heads_v1(account_id,trade_date,checksum,plan_id) VALUES(?,?,?,?)').run(1,'2026-09-11','c','p')
   f.sqls.paper.prepare('INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,revision,payload_json) VALUES(?,?,?,?,0,?)').run(2,date,'c','p','{}')
   f.sqls.paper.prepare('INSERT INTO paper_daily_plan_heads_v1(account_id,trade_date,checksum,plan_id) VALUES(?,?,?,?)').run(2,date,'c','p')
  }
  if(scenario!=='no_chain'){
   insert.run(date,'premarket_v3:allocate',date+':premarket-v3','success','{}',1,null)
   insert.run(date,'premarket_v3:publish:0',date+':premarket-v3',scenario==='health_only_error'?'queued':'error','{}',1,scenario==='health_only_error'?null:'premarket_session_expired:Error: daily_plan_publication_conflict')
   insert.run(date,'premarket_v3:market-health',date+':premarket-v3','error','{}',3,'Error: broker offline')
  }
  const input=scenario==='halted_with_reason'?{...readyMeta,status:'halted',error_message:'circuit_breaker'}:readyMeta
  const meta=await premarketPublicationDisplayMeta(f.env,date,input,Date.parse(date+'T10:00:00+08:00')) as any
  assert.equal(meta.status,'error');assert.equal(meta.original_status,input.status)
  if(scenario==='halted_with_reason')assert.equal(meta.original_error_message,'circuit_breaker')
  assert.equal(meta.error_message,scenario==='no_chain'?'premarket_publication_expired:not_started'
   :scenario==='health_only_error'?'premarket_publication_expired:publish:0:queued'
   :'premarket_publication_expired:publish:0:premarket_session_expired:Error: daily_plan_publication_conflict')
 }finally{f.close()}
})
test('publication display is not an expired flow on a closure announced after the run',async()=>{
 const f=fixture();withDailyPlanHeads(f)
 try{
  f.kvs.set(`holiday:${date}`,'1')
  assert.equal(await premarketPublicationDisplayMeta(f.env,date,readyMeta,Date.parse(date+'T10:00:00+08:00')),readyMeta)
  f.kvs.delete(`holiday:${date}`);f.kvs.set(`market:twse_adhoc_closure_check:v1:${date}`,'closed')
  assert.equal(await premarketPublicationDisplayMeta(f.env,date,readyMeta,Date.parse(date+'T10:00:00+08:00')),readyMeta)
  f.kvs.delete(`market:twse_adhoc_closure_check:v1:${date}`)
  f.kvs.set(`market:twse_holiday_schedule:v2:${date.slice(0,4)}`,JSON.stringify({schemaVersion:'twse-holiday-schedule-v2',dates:[date]}))
  assert.equal(await premarketPublicationDisplayMeta(f.env,date,readyMeta,Date.parse(date+'T10:00:00+08:00')),readyMeta)
 }finally{f.close()}
})
test('publication display reads cached closure state only: no TWSE fetch, no KV write',async()=>{
 const f=fixture();withDailyPlanHeads(f)
 const realFetch=globalThis.fetch;const kv=f.env.KV as any;const realPut=kv.put;const realDelete=kv.delete
 const calls:string[]=[]
 try{
  globalThis.fetch=(async(url:string)=>{calls.push('fetch:'+url);throw new Error('no network')}) as typeof fetch
  kv.put=async(k:string)=>{calls.push('put:'+k)};kv.delete=async(k:string)=>{calls.push('delete:'+k)}
  const meta=await premarketPublicationDisplayMeta(f.env,date,readyMeta,Date.parse(date+'T10:00:00+08:00')) as any
  assert.equal(meta.status,'error');assert.deepEqual(calls,[])
 }finally{globalThis.fetch=realFetch;kv.put=realPut;kv.delete=realDelete;f.close()}
})
test('daily briefing keeps the failure reason visible when the failed run still lists items',()=>{
 const state=buildPendingBuyStateSummary([{symbol:'2330'} as any],{status:'error',error_message:'premarket_publication_expired:publish:0:queued'} as any)
 const text=formatPendingBuyBriefing([{symbol:'2330',name:'TSMC',ml_entry_price:1,ml_stop_loss:0.9} as any],state)
 assert.match(text,/^\*\*流程失敗\*\*.*\n狀態異常：premarket_publication_expired:publish:0:queued（以下候選不會執行）\n- \*\*2330 TSMC\*\*/)
})
for(const scenario of ['finalized','legacy_owner','error_run','check_unavailable'])test(`publication display leaves executable or non-applicable runs unchanged: ${scenario}`,async()=>{
 const f=fixture()
 try{
  if(scenario!=='check_unavailable')withDailyPlanHeads(f)
  else f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
  if(scenario==='legacy_owner')f.env.PAPER_DAILY_PLAN_OWNER=''
  if(scenario==='finalized'){
   f.sqls.paper.prepare('INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,revision,payload_json) VALUES(1,?,?,?,0,?)').run(date,'c','p','{}')
   f.sqls.paper.prepare('INSERT INTO paper_daily_plan_heads_v1(account_id,trade_date,checksum,plan_id) VALUES(1,?,?,?)').run(date,'c','p')
  }
  const input=scenario==='error_run'?{...readyMeta,status:'error',error_message:'premarket_no_decision:not_started'}:readyMeta
  const meta=await premarketPublicationDisplayMeta(f.env,date,input,Date.parse(date+'T09:30:00+08:00'))
  if(scenario==='check_unavailable')assert.deepEqual(meta,{...readyMeta,publication_check:'unavailable'})
  else assert.equal(meta,input)
 }finally{f.close()}
})
