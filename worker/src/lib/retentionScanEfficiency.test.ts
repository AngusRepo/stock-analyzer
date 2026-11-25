import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildRetentionArchiveOnlyQuery, retentionArchiveOnlyBinds, retentionR2PolicyConfig } from './retentionArchiveOnly'
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
    const rows = db.prepare(buildRetentionArchiveOnlyQuery(source,cursor)).all(...retentionArchiveOnlyBinds(source,cutoff,cursor,17) as string[])
    if (!rows.length) break
    actual.push(...rows.map(r=>r.__cursor_key));const last=rows.at(-1)!
    cursor={cursor_date:String(last.__archive_date),cursor_key:String(last.__cursor_key)}
   }
   assert.deepEqual(actual,expected)
   assert.ok(cursor)
   const plan=db.prepare('EXPLAIN QUERY PLAN '+buildRetentionArchiveOnlyQuery(source,cursor)).all(...retentionArchiveOnlyBinds(source,cutoff,cursor,17) as string[]).map(r=>String(r.detail)).join('\n')
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

test('archive pages over UNIQUE(symbol,date) tables stop at the global 500th date and read protected rows once', () => {
 const db = new DatabaseSync(':memory:')
 try {
  db.exec('CREATE TABLE chip_data(symbol TEXT NOT NULL,date TEXT NOT NULL,value REAL,UNIQUE(symbol,date)); CREATE INDEX by_date ON chip_data(date,symbol)')
  const put = db.prepare('INSERT INTO chip_data VALUES(?,?,?)')
  // Full history, every third day missing, listed late, delisted early, and too short.
  for (let i=0;i<700;i++) {
   put.run('full',day(i),i)
   if (i%3) put.run('gappy',day(i),i)
   if (i>=150) put.run('young',day(i),i)
   if (i<520) put.run('delisted',day(i),i)
   if (i>=600) put.run('short',day(i),i)
  }
  let anchors = 0, visits = 0
  db.function('anchor_probe', value => { anchors++; return value })
  db.function('visit', value => { visits++; return value })
  const configured = retentionR2PolicyConfig('canonical_market_hot_v1')!.sources.find(s => s.datasetId==='chip_data')!
  assert.ok(configured.archiveScan)
  const source = { ...configured, archiveScan: { ...configured.archiveScan,
   eligibilitySql: configured.archiveScan.eligibilitySql.replace('SELECT newer.date FROM','SELECT anchor_probe(newer.date) FROM') } }
  // Count the page scan's own index visits; the eligibility subqueries alias the table.
  const counted = (sql: string) => sql.replace('chip_data.date IS NOT NULL', 'visit(chip_data.date) IS NOT NULL')
  // The former page: the 500th-date bound as a second, separate upper bound.
  const twoBounds = (sql: string) => counted(sql.replace(`min(?, ${source.archiveScan.dateBoundSql})`, '?')
   .replace(`AND (${source.archiveScan.eligibilitySql})`, `AND (chip_data.date < ${source.archiveScan.dateBoundSql} AND ${source.archiveScan.eligibilitySql})`))
  const cutoff = day(650)
  const expected = db.prepare(`SELECT rowid FROM chip_data WHERE date < ? AND (${originalEligibility('chip_data','symbol')}) ORDER BY date,rowid`).all(cutoff).map(r=>r.rowid)
  assert.equal(expected.length, 270) // full 200, young 50, delisted 20, gappy and short none
  const pageBinds = (cursor: {cursor_date: string; cursor_key: string} | null) => retentionArchiveOnlyBinds(source,cutoff,cursor,40) as string[]
  const actual: unknown[] = []; let cursor: {cursor_date: string; cursor_key: string} | null = null
  for (let page=0;page<100;page++) {
   anchors = 0
   const rows = db.prepare(counted(buildRetentionArchiveOnlyQuery(source,cursor))).all(...pageBinds(cursor))
   // One anchor per symbol per page; gappy and short have no 500th row to probe.
   if (rows.length) assert.equal(anchors, 3)
   if (!rows.length) break
   actual.push(...rows.map(r=>r.__cursor_key)); const last=rows.at(-1)!
   cursor={cursor_date:String(last.__archive_date),cursor_key:String(last.__cursor_key)}
  }
  assert.deepEqual(actual,expected)
  assert.ok(cursor)
  // The final (empty) page ends its date range at the 500th date, not the cutoff.
  visits = 0
  assert.equal(db.prepare(counted(buildRetentionArchiveOnlyQuery(source,cursor))).all(...pageBinds(cursor)).length, 0)
  const oneBound = visits
  visits = 0
  assert.equal(db.prepare(twoBounds(buildRetentionArchiveOnlyQuery(source,cursor))).all(...pageBinds(cursor)).length, 0)
  const former = visits
  assert.ok(former > 1500, `former final page visits ${former}`) // every row from the 500th date to the cutoff
  assert.ok(oneBound < 20, `final page visits ${oneBound}`)
  const plan = db.prepare('EXPLAIN QUERY PLAN '+buildRetentionArchiveOnlyQuery(source,null)).all(cutoff,40).map(r=>String(r.detail)).join('\n')
  // Protected rows are gathered once, through index ranges, into an uncorrelated list.
  assert.match(plan,/SEARCH chip_data USING (COVERING )?INDEX \w+ \(date<\?\)/)
  assert.match(plan,/LIST SUBQUERY/)
  assert.match(plan,/SEARCH protected USING COVERING INDEX \w+ \(symbol=\? AND date>\? AND date<\?\)/)
  assert.doesNotMatch(plan,/CORRELATED SCALAR SUBQUERY[^\n]*\n[^\n]*retention_market_anchors/)
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
