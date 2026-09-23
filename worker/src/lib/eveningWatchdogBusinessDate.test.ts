import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'
import { buildAdminTriggerTaskMap } from './adminTriggerTaskMap'
import { resolveEveningWatchdogBusinessDate } from './eveningWatchdogBusinessDate'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'
import { evaluateHistoricalLearningLineageBoundary } from './historicalLearningLineageGuard'
import { TASK_POLICIES } from './schedulerPolicy'

for (const [name, clock, root, expected] of [
  ['weekday midnight','2026-09-22T16:20:00Z',{run_id:'root-22'},'2026-09-22'],
  ['Friday into Saturday','2026-09-18T17:20:00Z',{run_id:'root-friday'},'2026-09-18'],
  ['morning cutoff','2026-09-23T00:00:00Z',{run_id:'root-22'},undefined],
  ['no root','2026-09-22T16:20:00Z',null,undefined],
  ['mismatched receipt','2026-09-22T16:20:00Z',{run_id:'other',run_date:'2026-09-21'},undefined],
  ['new evening','2026-09-23T13:00:00Z',{run_id:'old'},undefined],
] as const) {
  for (const task of ['screener-v2-watchdog','indicator-queue-watchdog']) {
    test(`${task}: ${name}`, async () => {
      const keys:string[]=[]
      const env={KV:{get:async(key:string)=>{keys.push(key);return root}}} as any
      assert.equal(await resolveEveningWatchdogBusinessDate(env,task,undefined,Date.parse(clock)),expected)
      if(expected)assert.equal(keys[0],`scheduler:run:evening-chain:${expected}`)
      assert.equal(await resolveEveningWatchdogBusinessDate(env,task,'2026-09-20',Date.parse(clock)),'2026-09-20')
    })
  }
}
test('resolved date reaches worker task handlers after task map creation', async()=>{
 const context:any={};const dates:unknown[]=[]
 const c={req:{query:()=>undefined}}
 const tasks=buildAdminWorkerDomainTaskMap(c,{runMarketScreener:async(date:unknown)=>{dates.push(date)}} as any,context)
 context.businessDate='2026-09-22'
 await tasks.screener()
 assert.deepEqual(dates,['2026-09-22'])
})
test('midnight recovery keeps expired-session fence and does not stop on Saturday',()=>{
 for(const task of ['screener-v2-watchdog','indicator-queue-watchdog']) {
  assert.equal(TASK_POLICIES[task].holidayGated,false)
  assert.equal(evaluateHistoricalLearningLineageBoundary({task,signalDate:'2026-09-22',nextSessionDate:'2026-09-23',nowMs:Date.parse('2026-09-22T17:00:00Z')}).allowed,true)
  assert.equal(evaluateHistoricalLearningLineageBoundary({task,signalDate:'2026-09-22',nextSessionDate:'2026-09-23',nowMs:Date.parse('2026-09-23T01:00:00Z')}).allowed,false)
 }
})

for(const sample of [
 {clock:'2026-09-22T16:20:00Z',date:'2026-09-22',next:'2026-09-23'},
 {clock:'2026-09-18T17:20:00Z',date:'2026-09-18',next:'2026-09-21'},
])test(`HTTP watchdog receipt and handler stay on original root: ${sample.clock}`,async()=>{
 const sql=new DatabaseSync(':memory:')
 sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql','utf8'))
 const ops={prepare(query:string){let args:any[]=[];const st={bind(...a:any[]){args=a;return st},
  async first(){return sql.prepare(query).get(...args)??null},
  async all(){return {results:sql.prepare(query).all(...args),meta:{size_after:0}}},
  async run(){return {success:true,meta:{changes:Number(sql.prepare(query).run(...args).changes)}}}};return st}}
 const reads:string[]=[];const kvValues=new Map<string,string>([
  [`scheduler:run:evening-chain:${sample.date}`,JSON.stringify({run_id:'root',run_date:sample.date,status:'running'})],
  [`scheduler:run:indicator-queue:${sample.date}`,JSON.stringify({run_id:'root',run_date:sample.date,status:'success'})],
  [`cron:indicator-queue:${sample.date}:root:finalized`,'done'],
 ])
 const kv={async get(key:string,type?:string){reads.push(key);const v=kvValues.get(key);return v==null?null:type==='json'?JSON.parse(v):v},async put(key:string,value:string){kvValues.set(key,value)}}
 const market={prepare(query:string){const st={bind(){return st},async first(){return query.includes('canonical_market_daily')?{next_session_date:sample.next}:null},async all(){return {results:[],meta:{size_after:0}}}};return st}}
 const env={LOCAL_AUTH_BYPASS:'1',ENVIRONMENT:'test',KV:kv,OPS_DB:ops,MARKET_DB:market,DB:market,MULTI_D1_ACTIVE_DOMAINS:'ops,market'} as any
 const oldNow=Date.now;Date.now=()=>Date.parse(sample.clock)
 try{
  const route=createAdminTriggerRoutes({buildTaskMap:(c,context)=>buildAdminTriggerTaskMap(c,{} as any,context)})
  const response=await route.request('https://local.test/api/admin/trigger/indicator-queue-watchdog?sync=1',{method:'POST'},env)
  const body=await response.json() as any
  assert.equal(response.status,200,JSON.stringify(body))
  assert(reads.includes(`scheduler:run:indicator-queue:${sample.date}`),JSON.stringify(body))
  assert.equal(sql.prepare('SELECT business_date FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(body.ticket_id)!.business_date,sample.date)
 }finally{Date.now=oldNow;sql.close()}
})
