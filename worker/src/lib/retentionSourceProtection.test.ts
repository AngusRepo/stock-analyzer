import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { retentionR2PolicyConfig } from './retentionArchiveOnly'
import { buildExactRetentionDelete } from './retentionExactRows'
import { recentMarketRows, fundamentalAnchorEligibility } from './retentionSourceProtection'

test('market retention keeps 500 observations including old and delisted symbols', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,close REAL); CREATE INDEX prices_by_stock ON stock_prices(stock_id,date)')
    const put = db.prepare('INSERT INTO stock_prices VALUES(?,?,?)')
    for (let i=0;i<501;i++) put.run(1,new Date(Date.UTC(2022,0,1+i)).toISOString().slice(0,10),i)
    put.run(2,'2020-01-01',20)
    const source=retentionR2PolicyConfig('canonical_market_hot_v1')!.sources[0]
    const rows=db.prepare(`SELECT rowid __cursor_key,date __archive_date,* FROM stock_prices WHERE ${source.eligibilitySql}`).all()
    assert.equal(rows.length,1)
    const exact=buildExactRetentionDelete(source,rows)
    // A corrected/removed newest observation changes the 500-row boundary.
    db.exec("DELETE FROM stock_prices WHERE stock_id=1 AND date=(SELECT MAX(date) FROM stock_prices WHERE stock_id=1)")
    assert.equal(db.prepare(exact.sql).all(exact.rowsJson,'2026-01-01').length,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_prices WHERE stock_id=2').get()?.n,1)
    assert.throws(()=>recentMarketRows('injected','stock_id'),/anchor_invalid/)
  } finally { db.close() }
})

test('fundamentals retain pre-window as-of inputs, sparse sources and future corrections',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE canonical_fundamental_features(stock_id TEXT,source TEXT,available_date TEXT,as_of_date TEXT)`)
    const put=db.prepare('INSERT INTO canonical_fundamental_features VALUES(?,?,?,?)')
    for(let i=0;i<181;i++) {
      const date=new Date(Date.UTC(2023,0,1+i)).toISOString().slice(0,10)
      put.run('2330','daily',date,date)
    }
    put.run('2330','quarter','2020-01-01','2020-01-01')
    put.run('2317','quarter','2020-01-01','2020-01-01')
    put.run('2330','daily','2019-01-01','2030-01-01')
    // Hot/future rows cannot replace the anchor required by the first hot date.
    put.run('2330','daily','2026-01-01','2026-01-01')
    const eligible=fundamentalAnchorEligibility('2025-01-01')
    const rows=db.prepare(`SELECT stock_id,source,available_date FROM canonical_fundamental_features WHERE ${eligible}`).all().map(r=>({...r}))
    assert.deepEqual(rows,[{stock_id:'2330',source:'daily',available_date:'2023-01-01'}])
  } finally {db.close()}
})

test('execution retention respects actual FK order and keeps unresolved sibling evidence',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const ddl=readFileSync('domain-schemas/execution.sql','utf8')
    for(const table of ['broker_execution_intents','broker_execution_legs','broker_execution_events']) {
      const create=ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
      assert.ok(create);db.exec(create[0])
    }
    for(const [id,status] of [['done','FILLED'],['uncertain','FILLED']]) {
      db.prepare(`INSERT INTO broker_execution_intents(intent_id,idempotency_key,account_id,trade_date,symbol,side,status,packet_hash,approval_scope,requested_shares,limit_price,intent_json,packet_json) VALUES(?,?,1,'2020-01-01','2330','buy',?,'hash','paper',1,10,'{}','{}')`).run(id,id,status)
      db.prepare(`INSERT INTO broker_execution_legs(leg_id,intent_id,leg_key,client_tag,lot_type,requested_shares,broker_quantity,status,created_at) VALUES(?,?,?,?,'odd_lot',1,1,?,'2020-01-01')`).run(id,id,id,id,id==='done'?'FILLED':'UNKNOWN')
      db.prepare(`INSERT INTO broker_execution_events(event_id,intent_id,leg_id,event_type,event_status,event_time,payload_json,source) VALUES(?,?,?,'ORDER_CALLBACK','ok','2020-01-01','{}','paper')`).run(id,id,id)
    }
    const sources=retentionR2PolicyConfig('execution_ledger_v1')!.sources
    assert.deepEqual(sources.map(s=>s.datasetId),['broker_execution_events','broker_execution_legs','broker_execution_intents'])
    for(const s of sources) {
      const rows=db.prepare(`SELECT rowid __cursor_key,substr(${s.dateExpression},1,10) __archive_date,* FROM ${s.fromSql} WHERE ${s.eligibilitySql}`).all()
      assert.equal(rows.length,1)
      const exact=buildExactRetentionDelete(s,rows)
      assert.equal(db.prepare(exact.sql).all(exact.rowsJson,'2026-01-01').length,1)
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${s.fromSql}`).get()?.n,1)
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
    for(const s of sources)assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${s.fromSql} WHERE ${s.eligibilitySql}`).get()?.n,0)
  } finally {db.close()}
})
