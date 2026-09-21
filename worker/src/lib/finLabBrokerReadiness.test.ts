import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { brokerAsOfReadiness } from './finLabBrokerReadiness'

function fixture(t: any) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  for (const table of ['canonical_broker_flow_daily','canonical_broker_rank_daily']) {
    sql.exec('CREATE TABLE '+table+'(stock_id TEXT,date TEXT,as_of_date TEXT,source TEXT,market_segment TEXT)')
    sql.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO "+table+
      " SELECT printf('%04d',x),'2026-09-18','2026-09-18','finlab.broker_transactions','LISTED_OTC' FROM n")
  }
  sql.exec("CREATE TABLE canonical_market_index_daily(date TEXT,symbol TEXT); INSERT INTO canonical_market_index_daily VALUES('2026-09-21','TWII'),('2026-09-18','TWII'),('2026-09-17','TWII')")
  sql.exec('CREATE TABLE source_key_report(target_date TEXT,lane TEXT,field TEXT,api_key TEXT,source TEXT,status TEXT,error_code TEXT,generated_at TEXT,metadata_json TEXT)')
  const observation = {schema_version:'finlab-broker-source-observation-v1',raw_rows:2583838,
    valid_date_rows:2583838,required_columns_valid:true,raw_max_date:'2026-09-18',target_date:'2026-09-21',target_rows:0}
  const put = (changes: Record<string, unknown> = {}) => {
    sql.exec('DELETE FROM source_key_report')
    sql.prepare('INSERT INTO source_key_report VALUES(?,?,?,?,?,?,?,?,?)').run(
      '2026-09-21','broker_flow_diversity','broker_transactions','broker_transactions','finlab','empty',null,
      '2026-09-21T14:20:00Z',JSON.stringify({source_observation:{...observation,...changes}}))
  }
  put()
  class Statement {
    constructor(readonly text: string, readonly values: any[] = []) {}
    bind(...values: any[]) { return new Statement(this.text,values) }
    async first() { return sql.prepare(this.text).get(...this.values) ?? null }
    async all() { return {results:sql.prepare(this.text).all(...this.values)} }
  }
  const db={prepare:(text:string)=>new Statement(text)} as unknown as D1Database
  return {sql,put,check:()=>brokerAsOfReadiness(db,db,'2026-09-21')}
}
test('verified Friday data may serve Monday as-of without changing dates',async t=>{
  const {sql,check}=fixture(t)
  const result=await check()
  assert(result.every(r=>r.ok && r.summary.includes('source_date=2026-09-18') && r.summary.includes('age_sessions=1')))
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM canonical_broker_flow_daily WHERE date='2026-09-21'").get()?.n,0)
})
test('complete current session needs no fallback observation',async t=>{
  const {sql,check}=fixture(t)
  sql.exec("UPDATE canonical_broker_flow_daily SET date='2026-09-21'; UPDATE canonical_broker_rank_daily SET date='2026-09-21'; DELETE FROM source_key_report")
  assert((await check()).every(r=>r.ok && r.summary.includes('age_sessions=0')))
})
for(const [name,changes] of [
  ['unsupported schema',{required_columns_valid:false}],
  ['invalid raw dates',{valid_date_rows:2583837}],
  ['empty raw source',{raw_rows:0,valid_date_rows:0}],
  ['older than previous session',{raw_max_date:'2026-09-17'}],
  ['current data exists at provider',{target_rows:1}],
  ['wrong target',{target_date:'2026-09-18'}],
] as const) test(name+' blocks fallback',async t=>{
  const {put,check}=fixture(t);put(changes);assert((await check()).every(r=>!r.ok))
})
for(const [name,mutation] of [
  ['missing current observation','DELETE FROM source_key_report'],
  ['failed fetch',"UPDATE source_key_report SET error_code='network_error'"],
  ['old observation',"UPDATE source_key_report SET generated_at='2026-09-18T15:00:00Z'"],
  ['after target Taipei day',"UPDATE source_key_report SET generated_at='2026-09-21T16:01:00Z'"],
  ['partial current rows',"UPDATE canonical_broker_flow_daily SET date='2026-09-21' WHERE stock_id='0001'"],
  ['insufficient previous coverage',"DELETE FROM canonical_broker_rank_daily WHERE stock_id='0001'"],
  ['future-known rows',"UPDATE canonical_broker_flow_daily SET as_of_date='2026-09-22'"],
  ['missing current market session',"DELETE FROM canonical_market_index_daily WHERE date='2026-09-21'"],
] as const) test(name+' blocks fallback',async t=>{
  const {sql,check}=fixture(t);sql.exec(mutation);assert((await check()).every(r=>!r.ok))
})

