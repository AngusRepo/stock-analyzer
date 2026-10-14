import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { recordPipelineProgress, validPipelineProgress, pipelineProgressForDisplay, type PipelineProgress } from './pipelineProgress'

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
  assert.deepEqual(pipelineProgressForDisplay(parent(),progress()),p)
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
