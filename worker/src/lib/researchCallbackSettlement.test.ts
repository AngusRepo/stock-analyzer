import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { settleResearchCallback } from './researchCallbackSettlement'
test('weekly audit/IC settle exact tickets; duplicate terminals and stale identity cannot overwrite them',async()=>{
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql','utf8'))
  const db={prepare(q:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},
    async first(){return sql.prepare(q).get(...args)??null},async run(){return {meta:{changes:sql.prepare(q).run(...args).changes}}}};return stmt}} as unknown as D1Database
  for (const task of ['weekly-audit','model-ic-full-check']) {
    sql.prepare(`INSERT INTO scheduler_execution_tickets_v1
      (ticket_id,dedupe_key,root_ticket_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum)
      VALUES (?,?,?,?,'2026-10-16','run-a','attempt','physical_root','triggered','scheduler_http','checksum')`).run(task,task,task,task)
    const input={task,date:'2026-10-16',ticketId:task,runId:'run-a',status:'error' as const,summary:'failed',error:'real failure'}
    for (const wrong of [{runId:'old'},{date:'2026-10-15'},{task:'monthly-optuna'}]) {
      await assert.rejects(settleResearchCallback(db,{...input,...wrong}),/identity_mismatch/)
    }
    const first=await settleResearchCallback(db,input)
    assert.equal(first.status,'error');assert(first.completed_at)
    assert.deepEqual(await settleResearchCallback(db,{...input,summary:'duplicate'}),first)
    await assert.rejects(settleResearchCallback(db,{...input,status:'success'}),/transition rejected/)
  }
  sql.close()
})
