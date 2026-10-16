import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { validFinLabStageProgress, matchesFinLabParent, recordFinLabStageProgress, finlabProgressForDisplay, type FinLabStageProgress } from './finlabStageProgress'

const p: FinLabStageProgress = {run_id:'run-a',run_date:'2026-10-16',dispatch_attempt:1,sequence:1,
  observed_at:'2026-10-16T14:00:00Z',phases:[{phase:'acquire',status:'running',started_at:'2026-10-16T14:00:00Z'}]}
test('one active phase, valid order, exact date/run/attempt display', () => {
  assert(validFinLabStageProgress(p))
  assert(!validFinLabStageProgress({...p,phases:[...p.phases,{...p.phases[0],phase:'validate'}]}))
  assert(!validFinLabStageProgress({...p,phases:[{...p.phases[0],phase:'publish'}]}))
  assert(!matchesFinLabParent(p,{run_id:'run-b'}))
  assert(!matchesFinLabParent(p,{run_id:'run-a',summary:'dispatch_attempt=2'}))
  assert.equal(finlabProgressForDisplay({run_id:'run-b'},{cursor_key:JSON.stringify(p)}),null)
  assert.deepEqual(finlabProgressForDisplay({run_id:'run-a'},{cursor_key:JSON.stringify(p)}),p)
})
test('duplicate and older progress cannot overwrite newer phase; business lease remains unchanged', async () => {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('migrations/0074_pipeline_stage_and_maintenance_control.sql','utf8'))
  sql.exec("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,lease_owner) VALUES('2026-10-16','finlab_market','owner','running','lease')")
  const db={prepare(query:string){let args:any[]=[];const s={bind(...v:any[]){args=v;return s},async first(){return sql.prepare(query).get(...args)??null}};return s}} as unknown as D1Database
  assert(await recordFinLabStageProgress(db,p))
  assert(!await recordFinLabStageProgress(db,p))
  assert(await recordFinLabStageProgress(db,{...p,sequence:3}))
  assert(!await recordFinLabStageProgress(db,{...p,sequence:2}))
  assert(await recordFinLabStageProgress(db,{...p,dispatch_attempt:2}))
  assert(!await recordFinLabStageProgress(db,{...p,sequence:8}))
  const terminal = {...p,dispatch_attempt:2,sequence:2,phases:p.phases.map(r=>({...r,status:'failed' as const,completed_at:p.observed_at,elapsed_ms:0}))}
  assert(await recordFinLabStageProgress(db,terminal))
  assert.equal(sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='finlab_progress'").get()!.status,'error')
  const owner=sql.prepare("SELECT * FROM pipeline_stage_runs WHERE stage='finlab_market'").get()!
  assert.equal(owner.status,'running'); assert.equal(owner.lease_owner,'lease')
  sql.close()
})
