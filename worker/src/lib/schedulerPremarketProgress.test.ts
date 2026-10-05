import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { loadPremarketProgress, premarketExecutionDisplay, premarketWatchdogDisplay, type PremarketProgressRow } from './schedulerPremarketProgress'

const row: PremarketProgressRow = {
  business_date:'2026-10-06', stage:'premarket_v3:allocate', canonical_run_id:'2026-10-06:premarket-v3',
  status:'waiting', last_error:'Error: premarket_wait:l4_completion', queued_at:'2026-10-05 23:15:41',
  updated_at:'2026-10-05 23:39:15', signal_date:'2026-10-05', l3_run_id:'recovered-run', l3_checksum:'a'.repeat(64),
}
const pipeline = {business_date:'2026-10-05',canonical_run_id:'recovered-run',status:'waiting',last_error:'awaiting_premarket'}
const input = {jobId:'pipeline',today:'2026-10-06',businessDate:'2026-10-05',rows:[row],pipeline}

test('morning L4 receipt replaces the prior night waiting projection without marking success', () => {
  for (const jobId of ['pipeline','recommendation']) {
    const result = premarketExecutionDisplay({...input,jobId})!
    assert.equal(result.lastStatus,'running')
    assert.equal(result.lastRunAt,'2026-10-05T23:15:41Z')
    assert.equal(result.statusScope,'durable_event')
    assert.match(result.summary,/等待計算與正式發布/)
  }
  assert.equal(premarketExecutionDisplay({...input,jobId:'ml-predict'}),null)
  assert.equal(premarketExecutionDisplay({...input,rows:[]}),null)
})

test('stale receipts, other L3 owners and terminal pipeline failures cannot be masked', () => {
  for (const change of [
    {business_date:'2026-10-05'}, {canonical_run_id:'other'}, {signal_date:'2026-10-02'},
    {l3_run_id:'failed-run'}, {l3_checksum:null}, {status:'error'}, {status:'success'},
    {last_error:'Error: premarket_wait:context'},
  ]) assert.equal(premarketExecutionDisplay({...input,rows:[{...row,...change}]}),null)
  for (const status of ['error','success','running'])
    assert.equal(premarketExecutionDisplay({...input,pipeline:{...pipeline,status}}),null)
  for (const ticketStatus of ['error','blocked','success','skipped'])
    assert.equal(premarketExecutionDisplay({...input,ticketStatus}),null)
  assert.equal(premarketExecutionDisplay({...input,rows:[{...row,status:'running',last_error:null}]})?.lastStatus,'running')
})

test('read-only D1 query extracts the lineage from both active and completed stage receipts', async () => {
  const sql = new DatabaseSync(':memory:')
  sql.exec('CREATE TABLE pipeline_stage_runs (business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,last_error TEXT,queued_at TEXT,updated_at TEXT,cursor_key TEXT)')
  const receipt = {signal_date:row.signal_date,l3_receipt:{run_id:row.l3_run_id,checksum:row.l3_checksum}}
  const insert=sql.prepare('INSERT INTO pipeline_stage_runs VALUES (?,?,?,?,?,?,?,?)')
  for (const cursor of [receipt,{input:receipt,output:{plan_id:'plan'}}])
    insert.run(row.business_date,row.stage,row.canonical_run_id,row.status,row.last_error,row.queued_at,row.updated_at,JSON.stringify(cursor))
  insert.run('2026-10-05',row.stage,row.canonical_run_id,row.status,row.last_error,row.queued_at,row.updated_at,JSON.stringify(receipt))
  const db={prepare:(query:string)=>({bind:(...args:string[])=>({all:async()=>({results:sql.prepare(query).all(...args)})})})} as unknown as D1Database
  const before=sql.prepare('SELECT * FROM pipeline_stage_runs').all()
  const rows=await loadPremarketProgress(db,'2026-10-06')
  assert.equal(rows.length,2)
  for (const item of rows) {
    assert.equal(item.l3_run_id,row.l3_run_id)
    assert.equal(item.signal_date,row.signal_date)
    assert.equal(premarketExecutionDisplay({...input,rows:[item]})?.lastStatus,'running')
  }
  assert.deepEqual(sql.prepare('SELECT * FROM pipeline_stage_runs').all(),before)
  sql.close()
})

test('a completed watchdog check waiting for L4 is waiting; active and failed checks stay authoritative', () => {
  const summary='status=pending premarket_event_chain queued=0 ready_target=08:45 overdue=false stage=premarket_v3:allocate'
  assert.equal(premarketWatchdogDisplay('premarket-evidence-watchdog',{status:'triggered',summary})?.lastStatus,'waiting')
  for(const status of ['running','error','success'])
    assert.equal(premarketWatchdogDisplay('premarket-evidence-watchdog',{status,summary}),null)
  for(const ticketStatus of ['error','blocked','success','skipped'])
    assert.equal(premarketWatchdogDisplay('premarket-evidence-watchdog',{status:'triggered',summary},ticketStatus),null)
  assert.equal(premarketWatchdogDisplay('pipeline',{status:'triggered',summary}),null)
  assert.equal(premarketWatchdogDisplay('premarket-evidence-watchdog',{status:'triggered',summary:'other task'}),null)
})
