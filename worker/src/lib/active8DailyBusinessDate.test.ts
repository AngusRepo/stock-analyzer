import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'
import { buildAdminGcpTriggerTaskMap } from './adminTriggerGcpTasks'

for (const sample of [
  { name: 'post-midnight', days: [['2026-09-21','success']], expected: '2026-09-21' },
  { name: 'weekend gap', days: [['2026-09-18','success']], expected: '2026-09-18' },
  { name: 'latest failure is not hidden', days: [['2026-09-18','success'],['2026-09-21','error']], expected: '2026-09-21' },
  { name: 'future pipeline excluded', days: [['2026-09-21','success'],['2026-09-23','success']], expected: '2026-09-21' },
  { name: 'explicit date retained', days: [['2026-09-21','success']], requested: '2026-09-20', expected: '2026-09-20' },
  { name: 'missing source rejected', days: [], expected: undefined, error: true },
  { name: 'legacy behavior retained', days: [], expected: undefined, legacy: true },
]) {
  test(`daily business-date route: ${sample.name}`, async () => {
    const sql = new DatabaseSync(':memory:')
    sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
    sql.exec('CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,status TEXT)')
    for (const [day,status] of sample.days) sql.prepare('INSERT INTO pipeline_stage_runs VALUES(?,?,?)').run(day,'pipeline_execution',status)
    const ops = { prepare(query: string) {
      let args: any[] = []
      const statement = { bind(...values: any[]) { args=values; return statement },
        async first() { return sql.prepare(query).get(...args) ?? null },
        async all() { return { results: sql.prepare(query).all(...args), meta: { size_after: 0 } } },
        async run() { return { success:true, meta:{ changes:Number(sql.prepare(query).run(...args).changes) } } } }
      return statement
    } }
    const values = new Map<string,string>([['trading:config', JSON.stringify(sample.legacy ? {} : {l4Distribution:{}})]])
    const kv = { get: async (key:string,type?:string) => { const v=values.get(key); return v==null ? null : type==='json' ? JSON.parse(v):v },
      put: async (key:string,value:string) => { values.set(key,value) } }
    const env = { LOCAL_AUTH_BYPASS:'1', ENVIRONMENT:'test', KV:kv, OPS_DB:ops,
      MULTI_D1_ACTIVE_DOMAINS:'ops', DB:{prepare:()=>({all:async()=>({results:[],meta:{size_after:0}})})},
      ML_CONTROLLER_URL:'https://isolated-controller.test' } as any
    const requests: any[] = []
    const oldFetch=globalThis.fetch, oldNow=Date.now
    globalThis.fetch=async (_url,init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({status:'spawned'}) }
    Date.now=()=>Date.parse('2026-09-21T18:00:00Z')
    try {
      const routes=createAdminTriggerRoutes({buildTaskMap:(c,context)=>buildAdminGcpTriggerTaskMap(c,{} as any,context)})
      const response=await routes.request('https://local.test/api/admin/trigger/active8-oof-daily?sync=1'+(sample.requested ? '&date='+sample.requested:''),{method:'POST'},env)
      const body=await response.json() as any
      assert.equal(response.status,sample.error ? 503:200,JSON.stringify(body))
      if (sample.error) {
        assert.equal(requests.length,0)
        assert.match(body.error,/active8_daily_pipeline_business_date_missing/)
        assert.equal(sql.prepare('SELECT COUNT(*) n FROM scheduler_execution_tickets_v1').get()!.n,0)
      } else {
        assert.equal(requests.length,1)
        assert.equal(requests[0].end_date,sample.expected)
        const ticket=sql.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(body.ticket_id)!
        assert.equal(ticket.business_date,sample.expected ?? '2026-09-22')
        assert.equal(requests[0].scheduler_ticket_id,ticket.ticket_id)
        assert.equal(requests[0].scheduler_run_id,ticket.run_id)
      }
    } finally { globalThis.fetch=oldFetch; Date.now=oldNow; sql.close() }
  })
}
