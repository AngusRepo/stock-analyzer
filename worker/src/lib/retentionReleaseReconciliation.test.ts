import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { reconcileRetentionReleases } from './retentionReleaseReconciliation'
import { retentionR2PolicyConfig } from './retentionArchiveOnly'
import { sha256Text } from './datasetSnapshots'

async function fixture() {
  const sql=new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys=ON')
  const ddl=readFileSync('domain-schemas/ops.sql','utf8')
  for(const table of ['data_retention_policies','data_retention_runs','data_retention_run_items','data_retention_cursors','run_artifacts']) {
    const create=ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert.ok(create,table);sql.exec(create[0])
  }
  sql.exec(readFileSync('domain-migrations/learning/0050_retention_source_release.sql','utf8'))
  const source=retentionR2PolicyConfig('learning_lineage_v1')!.sources[0]
  sql.exec(`INSERT INTO data_retention_policies(policy_id,domain,dataset_pattern,hot_retention_days,cold_retention_days,archive_store,action,version,status,approved_reason)
    VALUES('learning_lineage_v1','learning','predictions',120,3650,'r2','archive_delete',1,'active','fixture')`)
  const raw=JSON.stringify({domain:'retention_learning_lineage_v1_predictions',schema_version:'d1-retention-hot-window-drain-v1',payload:{schema_version:'d1-retention-hot-window-drain-v1',policy_id:'learning_lineage_v1',dataset_id:'predictions',source_domain:'learning',rows:[{id:1}]}})
  const checksum=await sha256Text(raw)
  sql.prepare(`INSERT INTO learning_retention_releases_v1 VALUES('a',?,'predictions',1,'2020-01-01 00:00:00')`).run(checksum)
  sql.prepare(`INSERT INTO run_artifacts(artifact_id,retention_class,status,domain,business_date,producer_run_id,r2_key,checksum,schema_version,row_count,byte_size,retain_until,checksum_verified_at,created_at)
    VALUES('a','ten_year_cold_archive','ready','retention_learning_lineage_v1_predictions','2020-01-01','run','cold/a',?,'d1-retention-hot-window-drain-v1',1,?,'2036-01-01','2020-01-01','2020-01-01')`).run(checksum,raw.length)
  let lost=false,corrupt=false,gets=0
  function prepare(query:string){let params:any[]=[];return {query,bind(...v:any[]){params=v;return this},async first(){return sql.prepare(query).get(...params)??null},async all(){return {results:sql.prepare(query).all(...params)}},async run(){const r=sql.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}}}
  const db={prepare,async batch(items:any[]){sql.exec('BEGIN');try{const rows=[];for(const item of items)rows.push(await item.run());sql.exec('COMMIT');if(lost){lost=false;throw new Error('lost ack')}return rows}catch(e){if(sql.isTransaction)sql.exec('ROLLBACK');throw e}}} as unknown as D1Database
  const env={DB:db,ARTIFACTS:{async get(){gets++;return {text:async()=>corrupt?'corrupt':raw}}}} as any
  return {sql,db,env,source,checksum,lose(){lost=true},corrupt(){corrupt=true},get gets(){return gets}}
}

test('lost OPS ACK is repaired from sealed archive and immutable source receipt, once',async()=>{
  const f=await fixture()
  try {
    f.lose()
    await assert.rejects(reconcileRetentionReleases(f.env,f.db,f.source,'learning_lineage_v1'),/lost ack/)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM data_retention_cursors').get()?.n,0)
    const again=await reconcileRetentionReleases(f.env,f.db,f.source,'learning_lineage_v1')
    assert.equal(again.checked,1);assert.equal(again.reconciled,0)
    assert.equal(f.gets,1)
    assert.equal(f.sql.prepare('SELECT deleted_rows FROM data_retention_run_items').get()?.deleted_rows,1)
    assert.equal(f.sql.prepare('SELECT SUM(deleted_rows) n FROM data_retention_runs').get()?.n,0)
    assert.equal((await reconcileRetentionReleases(f.env,f.db,f.source,'learning_lineage_v1')).checked,0)
    assert.equal(f.sql.prepare('PRAGMA foreign_key_check').all().length,0)
  }finally{f.sql.close()}
})

test('corrupt archive cannot publish a release proof or move reconciliation cursor',async()=>{
  const f=await fixture();f.corrupt()
  try {
    await assert.rejects(reconcileRetentionReleases(f.env,f.db,f.source,'learning_lineage_v1'),/checksum_mismatch/)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM data_retention_run_items').get()?.n,0)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM data_retention_cursors').get()?.n,0)
  }finally{f.sql.close()}
})

test('new unsettled source receipts are deferred without being lost behind the cursor',async()=>{
  const f=await fixture()
  try {
    f.sql.prepare(`INSERT INTO learning_retention_releases_v1(artifact_id,checksum,dataset_id,row_count) VALUES('new',?,'predictions',1)`).run(f.checksum)
    const result=await reconcileRetentionReleases(f.env,f.db,f.source,'learning_lineage_v1')
    assert.equal(result.checked,1)
    assert.equal(f.sql.prepare('SELECT cursor_key FROM data_retention_cursors').get()?.cursor_key,'a')
  }finally{f.sql.close()}
})
