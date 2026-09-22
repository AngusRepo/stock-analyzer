import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildExactRetentionDelete, buildBoundedRetentionSelect } from './retentionExactRows'
import type { RetentionArchiveSource } from './retentionArchiveOnly'
const source: RetentionArchiveSource = {
 datasetId:'samples', sourceDomain:'learning',fromSql:'samples',selectSql:'samples.*',
 keyExpression:'samples.rowid',dateExpression:'samples.date',eligibilitySql:'samples.active=0',
 deleteTable:'samples',deleteKeyColumn:'rowid',
}
function fixture() {
 const db=new DatabaseSync(':memory:')
 db.exec(`CREATE TABLE samples(id INTEGER PRIMARY KEY,date TEXT,active INTEGER,value REAL,note TEXT);
 INSERT INTO samples VALUES(1,'2025-01-01',0,1.25,NULL),(2,'2025-01-02',0,2.5,'original'),(3,'2026-09-22',0,9,'hot');`)
 const rows=db.prepare("SELECT rowid __cursor_key,date __archive_date,* FROM samples WHERE id<=2 ORDER BY id").all()
 return {db,rows}
}
function remove(db: DatabaseSync, rows: Record<string,unknown>[]) {
 const q=buildExactRetentionDelete(source,rows)
 return db.prepare(q.sql).all(q.rowsJson,'2026-01-01')
}
test('exact scalar and null rows delete; current hot row survives',()=>{
 const {db,rows}=fixture();assert.equal(remove(db,rows).length,2)
 assert.deepEqual(db.prepare('SELECT id FROM samples').all().map(r=>r.id),[3]);db.close()
})
for (const [name,mutation] of [
 ['value changed',"UPDATE samples SET value=3 WHERE id=2"],
 ['null changed',"UPDATE samples SET note='' WHERE id=1"],
 ['eligibility changed',"UPDATE samples SET active=1 WHERE id=2"],
 ['one row deleted',"DELETE FROM samples WHERE id=2"],
 ['rowid reused',"DELETE FROM samples WHERE id=2; INSERT INTO samples VALUES(2,'2025-01-02',0,99,'replacement')"],
] as const) test(`whole batch survives when ${name} after preflight`,()=>{
 const {db,rows}=fixture();db.exec(mutation)
 assert.equal(remove(db,rows).length,0)
 assert.equal(db.prepare('SELECT COUNT(*) n FROM samples WHERE id=1').get()?.n,1);db.close()
})
test('malformed keys, duplicate keys, unsupported values and unsafe columns fail before SQL',()=>{
 const {db,rows}=fixture()
 assert.throws(()=>buildExactRetentionDelete(source,[rows[0],rows[0]]),/identity/)
 assert.throws(()=>buildExactRetentionDelete(source,[{...rows[0],__cursor_key:2**54}]),/identity/)
 assert.throws(()=>buildExactRetentionDelete(source,[{...rows[0],note:{a:1}}]),/unsupported/)
 assert.throws(()=>buildExactRetentionDelete(source,[{...rows[0],'x;drop table samples':1}]),/identifier/)
 db.close()
})

test('large rows are bounded in SQLite before transfer; dates and order stay exact',()=>{
 const {db}=fixture()
 db.prepare('UPDATE samples SET note=? WHERE id=1').run('漢'.repeat(1000))
 const columns=['id','date','active','value','note']
 const q=buildBoundedRetentionSelect(source,columns)
 assert.equal(db.prepare(q).all('2026-01-01',250,2000).length,0)
 const rows=db.prepare(q).all('2026-01-01',250,3500)
 assert.equal(rows.length,1);assert.equal(rows[0].id,1)
 assert.equal(db.prepare(q).all('2026-01-01',250,5000).length,2)
 db.close()
})

test('bounded scan uses the date index rather than scanning and sorting the whole history',()=>{
 const {db}=fixture();db.exec('CREATE INDEX samples_date ON samples(date)')
 const q=buildBoundedRetentionSelect(source,['id','date','active','value','note'])
 const plan=db.prepare('EXPLAIN QUERY PLAN '+q).all('2026-01-01',250,4096)
 assert(plan.some(row=>String(row.detail).includes('USING INDEX samples_date')))
 db.close()
})
