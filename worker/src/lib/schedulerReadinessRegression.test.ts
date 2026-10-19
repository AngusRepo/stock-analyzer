import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { getSchedulerStatus, resolveSchedulerLogStatus } from './schedulerStatus'
import { settlePremarketReadinessTickets } from './premarketReadinessTickets'
import { classifySchedulerSummary, isSchedulerStatus } from './schedulerRunLogger'
import { premarketReadinessDisplay, type PremarketProgressRow } from './schedulerPremarketProgress'
import { adminControlRoutes } from '../routes/adminControlRoutes'

const date='2026-10-19', run=date+':premarket-v3'
const input={signal_date:'2026-10-16',l3_receipt:{run_id:'l3-original',checksum:'a'.repeat(64)}}
function fixture() {
  const sql=new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE pipeline_stage_runs (
    business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT,
    processed_count INTEGER DEFAULT 0,persisted_count INTEGER DEFAULT 0,expected_count INTEGER,
    attempt_count INTEGER DEFAULT 0,queued_at TEXT,started_at TEXT,completed_at TEXT,
    lease_owner TEXT,lease_expires_at TEXT,last_error TEXT,updated_at TEXT,
    PRIMARY KEY(business_date,stage))`)
  sql.exec(fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql','utf8'))
  const statement=(query:string,args:any[]=[]):any=>({
    bind:(...values:any[])=>statement(query,values),
    all:async()=>({success:true,results:sql.prepare(query).all(...args)}),
    first:async()=>sql.prepare(query).get(...args) ?? null,
    run:async()=>({success:true,meta:{changes:Number(sql.prepare(query).run(...args).changes)}}),
  })
  const db={prepare:statement}
  const values=new Map<string,any>()
  const kv={get:async(key:string,type?:string)=>values.has(key)
    ? type==='json' ? values.get(key) : JSON.stringify(values.get(key)) : null,
    put:async(key:string,value:string)=>{values.set(key,JSON.parse(value))}}
  const env={DB:db,OPS_DB:db,KV:kv} as any
  const stage=(stage:string,status='success',output:any={},at='2026-10-19 04:38:19')=>{
    sql.prepare('INSERT OR REPLACE INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,updated_at) VALUES(?,?,?,?,?,?)')
      .run(date,'premarket_v3:'+stage,run,status,JSON.stringify({input,output}),at)
  }
  const ticket=(id:string,status='triggered',at='2026-10-19 04:37:59',summary='status=pending premarket_event_chain queued=1')=>{
    sql.prepare(`INSERT INTO scheduler_execution_tickets_v1
      (ticket_id,dedupe_key,root_ticket_id,task,business_date,run_id,attempt_id,ticket_kind,status,
       status_authority,attempt_count,payload_checksum,last_summary,updated_at)
      VALUES(?,?,?,'pre-market-warmup',?,?,?,'manual',?,'scheduler_http',1,?,?,?)`)
      .run(id,id,id,date,id,id+':attempt:1',status,'b'.repeat(64),summary,at)
  }
  return {sql,db:db as unknown as D1Database,env,values,stage,ticket}
}

test('FinLab failed callback blocks unexecuted market work while retaining the real root failure',async()=>{
  const f=fixture()
  try {
    f.env.STOCKVISION_AUTH_TOKEN='local-fixture-only'
    const response=await adminControlRoutes.request('/api/admin/scheduler-callback',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer local-fixture-only'},
      body:JSON.stringify({task:'finlab-v4-backfill',status:'error',run_date:date,run_id:'source-run',
        continue_evening_chain:true,error:'daily_composition_market_dates_missing:margin_balance',
        summary:'daily_composition_market_dates_missing:margin_balance'}),
    },f.env,{waitUntil:()=>{}} as any)
    assert.equal(response.status,200)
    const update=f.values.get('scheduler:run:update:'+date)
    assert.equal(update.status,'blocked')
    assert.match(update.summary,/executed=false/)
    assert.equal(f.values.get('scheduler:run:finlab-v4-backfill:'+date).status,'error')
    assert.equal(f.values.get('scheduler:run:evening-chain:'+date).status,'error')
    assert.equal(classifySchedulerSummary(update.summary),'blocked')
    assert.equal(isSchedulerStatus('blocked'),true)
    assert.equal(resolveSchedulerLogStatus(update,{id:'update',group:'pipeline_chain'}).status,'blocked')
    assert.equal(resolveSchedulerLogStatus({...update,status:'error',
      summary:'FinLab canonical backfill blocked market data continuation: margin missing'},
      {id:'update',group:'pipeline_chain'}).status,'blocked')
    assert.equal(resolveSchedulerLogStatus({...update,status:'error',duration_ms:200,summary:'actual market write error'},
      {id:'update',group:'pipeline_chain'}).status,'failed')
  } finally {f.sql.close()}
})

test('OBS uses a direct completed premarket receipt when the daily aggregate lost it',async()=>{
  const f=fixture()
  try {
    f.ticket('old-dispatch')
    f.values.set('scheduler:run:daily:'+date,{})
    f.values.set('scheduler:run:pre-market-warmup:'+date,{
      task:'pre-market-warmup',status:'success',run_id:run,run_date:date,
      summary:'status=success event_driven_ready',duration_ms:0,timestamp:'2026-10-19T04:38:24Z',
    })
    const result=await getSchedulerStatus(f.env,date)
    const job=result.jobs.find(j=>j.id==='pre-market-warmup')!
    assert.equal(job.lastStatus,'success')
    assert.equal(job.lastRunAt,'2026-10-19T04:38:24Z')
    assert.equal(job.statusRunDate,date)
  } finally {f.sql.close()}
})

test('same-owner completed D1 business receipts recover OBS even when both KV projections are missing',async()=>{
  const f=fixture()
  try {
    f.ticket('old-dispatch')
    f.stage('allocate','success',{},'2026-10-19 04:38:13')
    f.stage('publish:0','success',{ready:true,pending_status:'halted'})
    f.stage('market-health','success',{},'2026-10-19 00:30:09')
    const before=f.sql.prepare('SELECT * FROM scheduler_execution_tickets_v1').all()
    const result=await getSchedulerStatus(f.env,date)
    const job=result.jobs.find(j=>j.id==='pre-market-warmup')!
    assert.equal(job.lastStatus,'success')
    assert.equal(job.statusAuthority,'durable_pipeline_stage')
    assert.equal(job.statusRunDate,date)
    assert.equal(job.ticket.ticketId,run)
    assert.equal(job.lastRunAt,'2026-10-19T04:38:19.000Z')
    assert.deepEqual(f.sql.prepare('SELECT * FROM scheduler_execution_tickets_v1').all(),before,'read-only OBS must not settle tickets')
  } finally {f.sql.close()}
})

test('owning completion settles only prior waiting acknowledgements, idempotently',async()=>{
  const f=fixture()
  try {
    f.stage('allocate','success',{},'2026-10-19 04:38:13')
    f.stage('publish:0','success',{ready:true,pending_status:'halted'})
    f.stage('market-health','waiting')
    for(const id of ['wait-1','wait-2','wait-3'])f.ticket(id)
    f.ticket('failure','error')
    f.ticket('newer','triggered','2026-10-19 05:00:00')
    f.ticket('unrelated','triggered','2026-10-19 04:00:00','different operation')
    await settlePremarketReadinessTickets(f.db,date)
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM scheduler_execution_tickets_v1 WHERE status='success'").get()!.n,0)
    f.stage('market-health','success',{},'2026-10-19 00:30:09')
    await settlePremarketReadinessTickets(f.db,'2026-10-16')
    assert.equal(f.sql.prepare("SELECT status FROM scheduler_execution_tickets_v1 WHERE ticket_id='wait-1'").get()!.status,'triggered')
    await settlePremarketReadinessTickets(f.db,date)
    for(const id of ['wait-1','wait-2','wait-3'])assert.equal(f.sql.prepare('SELECT status FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(id)!.status,'success')
    assert.equal(f.sql.prepare("SELECT status FROM scheduler_execution_tickets_v1 WHERE ticket_id='failure'").get()!.status,'error')
    for(const id of ['newer','unrelated'])assert.equal(f.sql.prepare('SELECT status FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(id)!.status,'triggered')
    const after=f.sql.prepare('SELECT * FROM scheduler_execution_tickets_v1').all()
    await settlePremarketReadinessTickets(f.db,date)
    assert.deepEqual(f.sql.prepare('SELECT * FROM scheduler_execution_tickets_v1').all(),after)
  } finally {f.sql.close()}
})

test('publication alone, another date or different L3 lineage cannot claim readiness',()=>{
  const row:PremarketProgressRow={business_date:date,stage:'premarket_v3:publish:0',canonical_run_id:run,status:'success',
    publication_ready:1,pending_status:'halted',last_error:null,queued_at:null,updated_at:'2026-10-19 04:38:19',
    signal_date:input.signal_date,l3_run_id:input.l3_receipt.run_id,l3_checksum:input.l3_receipt.checksum}
  const allocate={...row,stage:'premarket_v3:allocate',updated_at:'2026-10-19 04:38:13'}
  const health={...row,stage:'premarket_v3:market-health'}
  assert.equal(premarketReadinessDisplay('pre-market-warmup',date,[row,allocate,health])?.lastStatus,'success')
  for(const rows of [[row,allocate],[row,health],[row,allocate,{...health,status:'waiting'}],
    [row,{...allocate,l3_run_id:'different'},health],[row,{...allocate,status:'running'},health],
    [row,{...allocate,updated_at:'2026-10-19 05:00:00'},health],
    [{...row,publication_ready:0},allocate,health]]) {
    assert.equal(premarketReadinessDisplay('pre-market-warmup',date,rows),null)
  }
  assert.equal(premarketReadinessDisplay('pre-market-warmup','2026-10-16',[row,allocate,health]),null)
  assert.equal(premarketReadinessDisplay('pre-market-warmup',date,[row,allocate,health],'2026-10-19 05:00:00'),null)
})
