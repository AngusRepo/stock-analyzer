import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { recordPipelineBatchProgress } from './pipelineBatchProgress'
test('batch receipts stay monotonic, scoped to active parent, and do not mutate the business stage',async()=>{
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  sql.exec("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status) VALUES('2026-10-16','pipeline_execution','run-a','waiting')")
  const db={prepare(q:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},async first(){return sql.prepare(q).get(...args)??null}};return stmt}} as unknown as D1Database
  const p={stage_id:'a'.repeat(64),phase:'input_prep' as const,completed:5,total:23,observed_at:'2026-10-16T15:32:00Z'}
  assert.equal(await recordPipelineBatchProgress(db,'2026-10-16','wrong',p),false)
  assert.equal(await recordPipelineBatchProgress(db,'2026-10-16','run-a',p),true)
  assert.equal(await recordPipelineBatchProgress(db,'2026-10-16','run-a',{...p,stage_id:'b'.repeat(64),observed_at:'2026-10-16T15:33:00Z'}),false)
  assert.equal(await recordPipelineBatchProgress(db,'2026-10-16','run-a',{...p,completed:3,observed_at:'2026-10-16T15:33:00Z'}),false)
  assert.equal(await recordPipelineBatchProgress(db,'2026-10-16','run-a',{...p,completed:23,observed_at:'2026-10-16T15:34:00Z'}),true)
  assert.equal(sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='pipeline_execution'").get()!.status,'waiting')
  sql.exec("UPDATE pipeline_stage_runs SET status='success' WHERE stage='pipeline_execution'")
  assert.equal(await recordPipelineBatchProgress(db,'2026-10-16','run-a',{...p,observed_at:'2026-10-16T15:40:00Z'}),false)
  sql.close()
})
