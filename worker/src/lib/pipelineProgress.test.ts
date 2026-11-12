import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { recordPipelineProgress, validPipelineProgress, pipelineProgressForDisplay, type PipelineProgress } from './pipelineProgress'
import { recordPipelineBatchProgress } from './pipelineBatchProgress'
import { acceptPipelineExecutionCallback, commitPipelineExecutionDispatch, failPipelineExecutionDispatch, reservePipelineExecutionDispatch } from './pipelineStageLease'

test('progress is ordered, run-fenced, and cannot reopen a terminal pipeline or change its dispatch lease', async () => {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  sql.exec("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,lease_owner) VALUES('2026-10-14','pipeline_execution','run-a','waiting','execution-a','original-owner')")
  const db={prepare(query:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},async first(){return sql.prepare(query).get(...args)??null}};return stmt}} as unknown as D1Database
  const p:PipelineProgress={phase:'input_snapshot',status:'waiting',started_at:'2026-10-14T16:19:00Z',phase_started_at:'2026-10-14T16:54:00Z',observed_at:'2026-10-14T16:54:01Z',execution_id:'execution-a',completed:[]}
  assert(validPipelineProgress(p))
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-other',p),false)
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-a',p),true)
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-a',p),false)
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-a',{...p,observed_at:'2026-10-14T16:54:00Z'}),false)
  const parent=()=>sql.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='pipeline_execution'").get() as any
  const progress=()=>sql.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='pipeline_progress'").get() as any
  assert.equal(parent().status,'waiting');assert.equal(parent().cursor_key,'execution-a');assert.equal(parent().lease_owner,'original-owner')
  assert.deepEqual(pipelineProgressForDisplay(parent(),progress()),{...p,phase_rank:20,executions:{'execution-a':[]}})
  const atomic={phase:'node_capture_atomic_inputs',elapsed_ms:1780000,status:'completed' as const}
  await recordPipelineProgress(db,'2026-10-14','run-a',{...p,completed:[atomic],observed_at:'2026-10-14T16:55:00Z'})
  await recordPipelineProgress(db,'2026-10-14','run-a',{...p,execution_id:'execution-b',started_at:'2026-10-14T17:00:00Z',
    phase_started_at:'2026-10-14T17:00:00Z',observed_at:'2026-10-14T17:00:01Z'})
  const resumed=pipelineProgressForDisplay(parent(),progress())!
  assert.equal(resumed.started_at,p.started_at)
  assert.deepEqual(resumed.executions,{'execution-a':[atomic],'execution-b':[]})
  await recordPipelineProgress(db,'2026-10-14','run-a',{...p,phase:'modal_inference',status:'running',execution_id:'modal-one',
    phase_started_at:'2026-10-14T17:02:00Z',observed_at:'2026-10-14T17:02:01Z'})
  await recordPipelineProgress(db,'2026-10-14','run-a',{...p,phase:'dispatch_prediction',status:'completed',execution_id:'execution-b',
    phase_started_at:'2026-10-14T17:01:00Z',observed_at:'2026-10-14T17:03:00Z'})
  assert.equal(pipelineProgressForDisplay(parent(),progress())!.phase,'modal_inference','late dispatch acknowledgement cannot replace actual computation')
  sql.exec("UPDATE pipeline_stage_runs SET status='success' WHERE stage='pipeline_execution'")
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-a',{...p,observed_at:'2026-10-14T17:00:00Z'}),false)
  sql.exec("UPDATE pipeline_stage_runs SET canonical_run_id='run-b',status='waiting' WHERE stage='pipeline_execution'")
  assert.equal(pipelineProgressForDisplay(parent(),progress()),null)
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-b',{...p,observed_at:'2026-10-14T17:01:00Z'}),true)
  assert.equal(validPipelineProgress({...p,completed:[{phase:'x',elapsed_ms:-1,status:'completed'}]}),false)
  sql.close()
})

test('newer same-run handoff supersedes an old node but preserves matching or newer telemetry', () => {
  const parent={canonical_run_id:'run-a',status:'waiting'}
  const p:PipelineProgress={phase:'node_l2_timesfm_enrich',status:'running',started_at:'2026-10-14T16:19:00Z',
    phase_started_at:'2026-10-14T17:45:00Z',observed_at:'2026-10-14T17:45:01Z',execution_id:'job-a',completed:[]}
  const row=(value:PipelineProgress)=>({canonical_run_id:'run-a',cursor_key:JSON.stringify(value)})
  const handoff={runId:'run-a',observedAt:'2026-10-14T17:58:13Z',phase:'modal_prediction'}
  assert.deepEqual(pipelineProgressForDisplay(parent,row(p),handoff),{
    ...p,phase:'modal_prediction',status:'waiting',phase_started_at:handoff.observedAt,
    observed_at:handoff.observedAt,execution_id:'',evidence_source:'scheduler_handoff'})
  assert.deepEqual(pipelineProgressForDisplay(parent,row(p),{...handoff,runId:'other'}),p)
  const matching={...p,phase:'modal_prediction',status:'waiting' as const}
  assert.deepEqual(pipelineProgressForDisplay(parent,row(matching),handoff),matching)
  const next={...p,phase:'node_l3_formal_predict',observed_at:'2026-10-14T18:00:00Z'}
  assert.deepEqual(pipelineProgressForDisplay(parent,row(next),handoff),next)
})

test('pre-L2 preparation phases rank before payload build so the current phase keeps advancing', async () => {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  sql.exec("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key) VALUES('2026-10-22','pipeline_execution','run-a','running','execution-a')")
  const db={prepare(query:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},async first(){return sql.prepare(query).get(...args)??null}};return stmt}} as unknown as D1Database
  const base:PipelineProgress={phase:'node_load_market_env',status:'completed',started_at:'2026-10-22T10:00:00Z',phase_started_at:'2026-10-22T10:00:00Z',observed_at:'2026-10-22T10:00:01Z',execution_id:'execution-a',completed:[]}
  const phases=['node_attach_serving_context','node_prepare_l2_inputs','node_build_payloads','node_resume_l2_inputs']
  for (const [index,phase] of phases.entries()) {
    const at=`2026-10-22T10:0${index+1}:00Z`
    assert.equal(await recordPipelineProgress(db,'2026-10-22','run-a',{...base,phase,status:'running',phase_started_at:at,observed_at:at}),true)
    const row=sql.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='pipeline_progress'").get() as any
    const parent=sql.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='pipeline_execution'").get() as any
    assert.equal(pipelineProgressForDisplay(parent,row)!.phase,phase)
  }
  sql.close()
})

test('sequence-only freeze node keeps the rank of the L2 boundary it replaced', async () => {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  sql.exec("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key) VALUES('2026-10-14','pipeline_execution','run-a','running','execution-a')")
  const db={prepare(query:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},async first(){return sql.prepare(query).get(...args)??null}};return stmt}} as unknown as D1Database
  const p:PipelineProgress={phase:'node_prepare_sequence_inputs',status:'running',started_at:'2026-10-14T16:19:00Z',
    phase_started_at:'2026-10-14T17:45:00Z',observed_at:'2026-10-14T17:45:01Z',execution_id:'execution-a',completed:[]}
  assert.equal(await recordPipelineProgress(db,'2026-10-14','run-a',p),true)
  const row=sql.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='pipeline_progress'").get() as any
  assert.equal(pipelineProgressForDisplay({canonical_run_id:'run-a',status:'running'},row)!.phase_rank,30)
  sql.close()
})

function sqliteD1(sql: DatabaseSync) {
  const prepare=(query:string)=>{let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},
    async first(){return sql.prepare(query).get(...args)??null},
    async run(){sql.prepare(query).run(...args);return {success:true}},
    all(){return sql.prepare(query).all(...args)}};return stmt}
  return {prepare,async batch(statements:Array<{all():unknown[]}>){
    sql.exec('BEGIN')
    try { const out=statements.map(s=>({results:s.all()}));sql.exec('COMMIT');return out }
    catch(error){sql.exec('ROLLBACK');throw error}
  }} as unknown as D1Database
}

test('terminal pipeline_execution closes its progress rows; stale callbacks and other runs leave them; re-dispatch reopens', async () => {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  const db=sqliteD1(sql)
  const day='2026-11-10'
  const p:PipelineProgress={phase:'node_write_d1',status:'completed',started_at:'2026-11-10T14:00:00Z',phase_started_at:'2026-11-10T14:30:00Z',observed_at:'2026-11-10T14:30:01Z',execution_id:'execution-a',completed:[]}
  const batch={stage_id:'a'.repeat(64),phase:'input_prep' as const,completed:23,total:23,observed_at:'2026-11-10T14:10:00Z'}
  const row=(stage:string)=>({...sql.prepare('SELECT canonical_run_id,status,completed_at FROM pipeline_stage_runs WHERE business_date=? AND stage=?').get(day,stage)}) as any
  sql.exec(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status) VALUES('${day}','pipeline_execution','run-a','waiting'),
    ('2026-11-09','pipeline_execution','run-a','success'),('2026-11-09','pipeline_progress','run-a','running')`)
  assert.equal(await recordPipelineProgress(db,day,'run-a',p),true)
  assert.equal(await recordPipelineBatchProgress(db,day,'run-a',batch),true)
  assert.equal(await acceptPipelineExecutionCallback(db,{businessDate:day,runId:'run-stale',status:'success'}),null)
  assert.equal(row('pipeline_progress').status,'running','a stale callback does not close the current run')
  assert.equal((await acceptPipelineExecutionCallback(db,{businessDate:day,runId:'run-a',status:'success'}))?.status,'success')
  assert.equal(row('pipeline_execution').status,'success')
  assert.equal(row('pipeline_progress').status,'success')
  assert.ok(row('pipeline_progress').completed_at)
  assert.equal(row('pipeline_batches:input_prep').status,'success')
  assert.equal((sql.prepare("SELECT status FROM pipeline_stage_runs WHERE business_date='2026-11-09' AND stage='pipeline_progress'").get() as any).status,'running','other dates untouched')
  // An error parent recovered under a new canonical run reopens the progress row as running.
  sql.exec(`UPDATE pipeline_stage_runs SET status='error' WHERE business_date='${day}' AND stage='pipeline_execution'`)
  sql.exec(`UPDATE pipeline_stage_runs SET status='error' WHERE business_date='${day}' AND stage IN ('pipeline_progress','pipeline_batches:input_prep')`)
  assert.ok(await reservePipelineExecutionDispatch(db,{businessDate:day,attemptId:'resume',expectedFailedRunId:'run-a'}))
  assert.ok(await commitPipelineExecutionDispatch(db,{businessDate:day,attemptId:'resume',runId:'resume'}))
  assert.equal(await recordPipelineProgress(db,day,'resume',{...p,execution_id:'execution-b',observed_at:'2026-11-10T23:00:00Z',phase_started_at:'2026-11-10T23:00:00Z',started_at:'2026-11-10T23:00:00Z'}),true)
  assert.equal(await recordPipelineBatchProgress(db,day,'resume',{...batch,observed_at:'2026-11-10T23:00:00Z'}),true)
  assert.deepEqual(row('pipeline_progress'),{canonical_run_id:'resume',status:'running',completed_at:null})
  assert.deepEqual(row('pipeline_batches:input_prep'),{canonical_run_id:'resume',status:'running',completed_at:null})
  assert.equal((await acceptPipelineExecutionCallback(db,{businessDate:day,runId:'resume',status:'error',error:'boom'}))?.status,'error')
  assert.equal(row('pipeline_progress').status,'error')
  assert.equal(row('pipeline_batches:input_prep').status,'error')
  sql.close()
})

test('a failed dispatch closes progress rows of its own attempt only', async () => {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  const db=sqliteD1(sql)
  const day='2026-11-11'
  assert.ok(await reservePipelineExecutionDispatch(db,{businessDate:day,attemptId:'attempt-a'}))
  sql.exec(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status) VALUES('${day}','pipeline_progress','attempt-a','running'),
    ('${day}','pipeline_batches:prepare_prediction_request','older-run','running')`)
  assert.equal(await failPipelineExecutionDispatch(db,{businessDate:day,attemptId:'attempt-other',error:'x'}),false)
  assert.equal((sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='pipeline_progress'").get() as any).status,'running')
  assert.equal(await failPipelineExecutionDispatch(db,{businessDate:day,attemptId:'attempt-a',error:'dispatch failed'}),true)
  assert.equal((sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='pipeline_progress'").get() as any).status,'error')
  assert.equal((sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='pipeline_batches:prepare_prediction_request'").get() as any).status,'running')
  sql.close()
})
