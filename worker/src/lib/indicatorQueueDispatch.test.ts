import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { claimIndicatorQueueDispatch, closeHandedOffIndicatorRun } from './indicatorQueueDispatch'

async function main() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE scheduler_locks(lock_key TEXT PRIMARY KEY,owner TEXT,run_date TEXT,run_id TEXT,created_at TEXT,expires_at TEXT)')
  const values = new Map<string,string>()
  const db = { prepare(sql:string) { return { bind(...args:any[]) {
    return { async first() {return sqlite.prepare(sql).get(...args) ?? null},
      async run() {return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}} }
  } } } }
  const env:any = {DB:db,KV:{async put(key:string,value:string){values.set(key,value)},async get(key:string,type?:string) {
    const value=values.get(key);return value==null?null:type==='json'?JSON.parse(value):value
  }}}
  const date='2026-09-24'
  const results=await Promise.all(Array.from({length:8},()=>claimIndicatorQueueDispatch(env,date)))
  assert.equal(results.filter(Boolean).length,1,'concurrent callbacks must share one dispatch owner')
  const original=results.find(Boolean)!
  assert.equal(await claimIndicatorQueueDispatch(env,date,true),null,'unexpired owner without receipt must not fork')
  sqlite.prepare('UPDATE scheduler_locks SET expires_at=?').run('2000-01-01T00:00:00Z')
  assert.equal(await claimIndicatorQueueDispatch(env,date),original,'crash before receipt resumes original run')
  values.set(`scheduler:run:indicator-queue:${date}`,JSON.stringify({run_id:original}))
  assert.equal(await claimIndicatorQueueDispatch(env,date,true),null,'force does not fork unfinished chain')
  values.set(`cron:indicator-queue:${date}:${original}:finalized`,'1')
  assert.equal(await claimIndicatorQueueDispatch(env,date),null,'ordinary duplicate stays blocked after completion')
  const forced=await Promise.all([claimIndicatorQueueDispatch(env,date,true),claimIndicatorQueueDispatch(env,date,true)])
  assert.equal(forced.filter(Boolean).length,1,'completed explicit force is still atomic')
  assert.notEqual(forced.find(Boolean),original)
  sqlite.exec("CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT)")
  assert.equal(await closeHandedOffIndicatorRun(env,date,original),false)
  sqlite.prepare('INSERT INTO pipeline_stage_runs VALUES (?,?,?,?,?)').run(date,'screener_v2','canonical','running','producer')
  assert.equal(await closeHandedOffIndicatorRun(env,date,original),true)
  const closed=JSON.parse(values.get(`cron:indicator-queue:${date}:${original}:finalized`)!)
  assert.deepEqual(closed,{handoff_owner:'canonical',stage:'screener_v2',superseded:true})
  sqlite.prepare("UPDATE pipeline_stage_runs SET cursor_key=NULL").run()
  assert.equal(await closeHandedOffIndicatorRun(env,date,'incomplete-trigger'),false)
  sqlite.close()
  console.log('indicatorQueueDispatch tests passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
