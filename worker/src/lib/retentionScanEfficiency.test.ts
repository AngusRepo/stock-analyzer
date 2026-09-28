import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildRetentionArchiveOnlyQuery, retentionR2PolicyConfig } from './retentionArchiveOnly'
import { recentMarketRowsScan } from './retentionMarketScan'

const day = (n: number) => new Date(Date.UTC(2020, 0, 1 + n)).toISOString().slice(0, 10)
const originalEligibility = (table: string, key: string) => `${table}.date < (
 SELECT newer.date FROM ${table} newer WHERE newer.${key}=${table}.${key}
 ORDER BY newer.date DESC LIMIT 1 OFFSET 499)`

for (const [table, key] of [['stock_prices','stock_id'], ['technical_indicators','stock_id'], ['chip_data','symbol'], ['margin_data','stock_id']]) {
 test(`${table}: indexed pages exactly preserve the original 500-observation boundary`, () => {
  const db = new DatabaseSync(':memory:')
  try {
   db.exec(`CREATE TABLE ${table}(${key} TEXT,date TEXT,value REAL);
     CREATE INDEX by_symbol ON ${table}(${key},date); CREATE INDEX by_date ON ${table}(date,${key});`)
   const put = db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`)
   for (const [symbol, count] of [['short',40],['below',499],['exact',500],['over',501],['long',620]] as const) {
    for (let i=0; i<count; i++) put.run(symbol,day(i),i)
   }
   // Duplicate dates at the boundary, NULL dates/keys and an inactive symbol.
   for (let i=0;i<502;i++) put.run('ties',day(Math.floor(i/2)),i)
   put.run('inactive','1999-01-01',1); put.run(null,'1999-01-01',1); put.run('long',null,1)
   const source = retentionR2PolicyConfig('canonical_market_hot_v1')!.sources.find(s => s.datasetId===table)!
   const cutoff = day(550)
   const expected = db.prepare(`SELECT rowid FROM ${table} WHERE substr(date,1,10) < ? AND (${originalEligibility(table,key)}) ORDER BY substr(date,1,10),rowid`).all(cutoff).map(r=>r.rowid)
   const actual: unknown[] = []; let cursor: {cursor_date: string; cursor_key: string} | null = null
   for (let page=0;page<100;page++) {
    const rows = db.prepare(buildRetentionArchiveOnlyQuery(source,cursor)).all(...(cursor ? [cutoff,cursor.cursor_date,cursor.cursor_key,17] : [cutoff,17]))
    if (!rows.length) break
    actual.push(...rows.map(r=>r.__cursor_key));const last=rows.at(-1)!
    cursor={cursor_date:String(last.__archive_date),cursor_key:String(last.__cursor_key)}
   }
   assert.deepEqual(actual,expected)
   assert.ok(cursor)
   const plan=db.prepare('EXPLAIN QUERY PLAN '+buildRetentionArchiveOnlyQuery(source,cursor)).all(cutoff,cursor.cursor_date,cursor.cursor_key,17).map(r=>String(r.detail)).join('\n')
   assert.match(plan,new RegExp(`SEARCH ${table} USING INDEX by_date \\(date>\\? AND date<\\?\\)`))
  } finally { db.close() }
 })
}

test('empty archive probes compute the anchor once per symbol, not once per historical row', () => {
 const db = new DatabaseSync(':memory:')
 try {
  db.exec('CREATE TABLE stock_prices(stock_id INTEGER,date TEXT); CREATE INDEX by_symbol ON stock_prices(stock_id,date); CREATE INDEX by_date ON stock_prices(date)')
  const put=db.prepare('INSERT INTO stock_prices VALUES(?,?)')
  for(let symbol=0;symbol<20;symbol++)for(let i=0;i<500;i++)put.run(symbol,day(i))
  let calls=0
  db.function('anchor_probe',value=>{calls++;return value})
  const run=(eligibility:string)=>{
   calls=0
   const sql=`SELECT rowid FROM stock_prices WHERE (${eligibility.replace('SELECT newer.date FROM','SELECT anchor_probe(newer.date) FROM')}) AND date<'2025-01-01' LIMIT 100`
   assert.equal(db.prepare(sql).all().length,0)
   return calls
  }
  const oldCalls=run(originalEligibility('stock_prices','stock_id'))
  const newCalls=run(recentMarketRowsScan('stock_prices','stock_id'))
  assert.equal(oldCalls,10_000);assert.equal(newCalls,20)
 } finally { db.close() }
})

test('timestamp archive cursors keep day then rowid order and exclude the entire cutoff day',()=>{
 const db=new DatabaseSync(':memory:')
 try {
  db.exec('CREATE TABLE analysis_runs(created_at TEXT,value TEXT);CREATE INDEX by_time ON analysis_runs(created_at)')
  for(const [date,value] of [['2020-01-01T23:59:59Z','first'],['2020-01-01 00:00:01','second'],['2020-01-02','cutoff'],['2020-01-02T00:00:01Z','cutoff-time'],[null,'null']]) db.prepare('INSERT INTO analysis_runs VALUES(?,?)').run(date,value)
  const source=retentionR2PolicyConfig('research_runs_v1')!.sources.find(s=>s.datasetId==='analysis_runs')!
  const first=db.prepare(buildRetentionArchiveOnlyQuery(source,null)).all('2020-01-02',1)
  const last=first[0]
  const next=db.prepare(buildRetentionArchiveOnlyQuery(source,{cursor_date:String(last.__archive_date),cursor_key:String(last.__cursor_key)})).all('2020-01-02',String(last.__archive_date),String(last.__cursor_key),10)
  assert.deepEqual([...first,...next].map(r=>r.value),['first','second'])
 } finally { db.close() }
})
