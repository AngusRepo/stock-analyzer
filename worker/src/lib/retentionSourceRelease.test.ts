import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { releaseArchivedRows } from './retentionSourceRelease'
import type { RetentionArchiveSource } from './retentionArchiveOnly'
const source: RetentionArchiveSource = {datasetId:'samples',sourceDomain:'learning',fromSql:'samples',selectSql:'samples.*',keyExpression:'samples.rowid',dateExpression:'samples.date',eligibilitySql:'active=0',deleteTable:'samples',deleteKeyColumn:'rowid'}
function fixture() {
 const sql=new DatabaseSync(':memory:')
 sql.exec(readFileSync('domain-migrations/learning/0050_retention_source_release.sql','utf8'))
 sql.exec("CREATE TABLE samples(id INTEGER PRIMARY KEY,date TEXT,active INTEGER,value REAL); INSERT INTO samples VALUES(1,'2025-01-01',0,10),(2,'2025-01-02',0,20);")
 const rows=sql.prepare('SELECT rowid __cursor_key,date __archive_date,* FROM samples').all()
 function prepare(query:string) {let params:any[]=[];return {query,get params(){return params},bind(...v:any[]){params=v;return this},async first(){return sql.prepare(query).get(...params)??null}}}
 let loseAck=false,failReceipt=false
 const db={prepare,async batch(stmts:any[]){sql.exec('BEGIN');try {
  const result=stmts.map((s,i)=>{if(i===1&&failReceipt)throw new Error('receipt write failed');const q=sql.prepare(s.query);return {results:q.columns().length?q.all(...s.params):(q.run(...s.params),[])}})
  sql.exec('COMMIT');if(loseAck)throw new Error('lost HTTP response');return result
 }catch(e){if(sql.isTransaction)sql.exec('ROLLBACK');throw e}}} as unknown as D1Database
 return {sql,db,rows,lose(){loseAck=true},fail(){failReceipt=true}}
}
const artifact={artifact_id:'sealed-fixture',checksum:'sha256:'+'a'.repeat(64)}
test('lost response retains source proof and idempotent retry',async()=>{
 const f=fixture();f.lose();await assert.rejects(releaseArchivedRows(f.db,source,'2026-01-01',f.rows,artifact),/lost HTTP/)
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM samples').get()?.n,0)
 assert.equal(await releaseArchivedRows(f.db,source,'2026-01-01',f.rows,artifact),2)
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM learning_retention_releases_v1').get()?.n,1)
 await assert.rejects(releaseArchivedRows(f.db,source,'2026-01-01',f.rows,{...artifact,checksum:'wrong'}),/identity_conflict/);f.sql.close()
})
test('proof failure rolls back deletion',async()=>{
 const f=fixture();f.fail();await assert.rejects(releaseArchivedRows(f.db,source,'2026-01-01',f.rows,artifact),/receipt write/)
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM samples').get()?.n,2);f.sql.close()
})
test('concurrent edit cannot publish false release',async()=>{
 const f=fixture();f.sql.exec('UPDATE samples SET value=30 WHERE id=2')
 await assert.rejects(releaseArchivedRows(f.db,source,'2026-01-01',f.rows,artifact),/CHECK constraint/)
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM samples').get()?.n,2)
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM learning_retention_releases_v1').get()?.n,0);f.sql.close()
})
test('source proofs immutable',async()=>{
 const f=fixture();await releaseArchivedRows(f.db,source,'2026-01-01',f.rows,artifact)
 assert.throws(()=>f.sql.exec('DELETE FROM learning_retention_releases_v1'),/immutable/)
 assert.throws(()=>f.sql.exec("UPDATE learning_retention_releases_v1 SET checksum='fake'"),/immutable/)
 assert.throws(()=>f.sql.exec("INSERT OR REPLACE INTO learning_retention_releases_v1 SELECT * FROM learning_retention_releases_v1"),/immutable/)
 f.sql.close()
})
