import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { mergeArchivedS12Evidence } from './retentionS12StructureReader'
import { hydrateS12StrategyEvidence } from './strategyLearning'
import { sha256Text } from './datasetSnapshots'

const DATE = '2025-01-02'
const row = (patch: Record<string, unknown> = {}) => ({ id:1, trade_date:DATE, symbol:'2330',
  source:'s12_candidate_snapshot',state:'ready',ready:1,invalidated:0,updated_at:'2025-01-02 09:00:00',...patch })
function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE run_artifacts(artifact_id TEXT,domain TEXT,r2_key TEXT,checksum TEXT,row_count INTEGER,byte_size INTEGER,schema_version TEXT,metadata_json TEXT,retention_class TEXT,status TEXT,payload_deleted_at TEXT);
    CREATE TABLE data_retention_run_items(status TEXT,deleted_rows INTEGER,evidence_json TEXT,completed_at TEXT);
    CREATE TABLE learning_retention_releases_v1(artifact_id TEXT,checksum TEXT,dataset_id TEXT,row_count INTEGER);
    CREATE TABLE s12_structure_snapshots(id INTEGER PRIMARY KEY,trade_date TEXT,symbol TEXT,source TEXT,state TEXT,ready INTEGER,invalidated INTEGER,updated_at TEXT,UNIQUE(trade_date,symbol,source));`)
  const objects = new Map<string,string>(); let reads = 0
  const adapter = {prepare(sql:string) {let params:any[]=[];return {
    bind(...args:any[]) {params=args;return this},
    async all() {return {results:db.prepare(sql).all(...params)}},
    async first() {return db.prepare(sql).get(...params) ?? null},
  }}}
  const env = {DB:adapter, ARTIFACTS:{async get(key:string) {reads++; const raw=objects.get(key);return raw===undefined?null:{size:Buffer.byteLength(raw),text:async()=>raw}}}} as any
  async function add(id:string,rows:any[],options:{released?:boolean,corrupt?:boolean,metadata?:object}={}) {
    const schema='d1-retention-hot-window-drain-v1',domain='retention_learning_lineage_v1_s12_structure_snapshots'
    const body={domain,schema_version:schema,payload:{schema_version:schema,source_domain:'learning',dataset_id:'s12_structure_snapshots',policy_id:'learning_lineage_v1',cutoff_date:'2026-01-01',rows:rows.map(r=>({...r,__cursor_key:r.id,__archive_date:r.trade_date}))}}
    const raw=JSON.stringify(body),checksum=await sha256Text(raw)
    objects.set(id,options.corrupt?'corrupt':raw)
    db.prepare('INSERT INTO run_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,domain,id,checksum,rows.length,Buffer.byteLength(raw),schema,JSON.stringify(options.metadata??{}),'ten_year_cold_archive','ready')
    if(options.released!==false) db.prepare('INSERT INTO learning_retention_releases_v1 VALUES(?,?,?,?)').run(id,checksum,'s12_structure_snapshots',rows.length)
  }
  function hot(r:ReturnType<typeof row>) {
    db.prepare('INSERT INTO s12_structure_snapshots VALUES(?,?,?,?,?,?,?,?)').run(r.id,r.trade_date,r.symbol,r.source,r.state,r.ready,r.invalidated,r.updated_at)
  }
  return {db,env,adapter:adapter as unknown as D1Database,add,hot,objects,get reads(){return reads}}
}

test('actual strategy hydrator is identical before and after verified cold transfer',async()=>{
  const f=fixture()
  try {
    const primary=row(),other=row({id:2,source:'s12_candidate_snapshot_reconstruction',ready:0})
    f.hot(primary);f.hot(other)
    const before:any[]=[{symbol:'2330'}]
    const expected=await hydrateS12StrategyEvidence(f.adapter,DATE,before,f.env)
    f.db.exec('DELETE FROM s12_structure_snapshots WHERE id=1')
    await f.add('archive',[primary])
    const after:any[]=[{symbol:'2330'}]
    assert.deepEqual(await hydrateS12StrategyEvidence(f.adapter,DATE,after,f.env),expected)
    assert.deepEqual(after,before)
    assert.equal(expected.available,1)
    assert.equal(f.reads,1)
  } finally {f.db.close()}
})
test('current natural key wins even if its row id differs from the archived revision',async()=>{
  const f=fixture()
  try {
    const current=row({id:200,state:'data_unavailable',ready:0});f.hot(current)
    await f.add('backup',[row()],{released:false})
    const result=await mergeArchivedS12Evidence(f.env,f.adapter,DATE,['2330'],[current])
    assert.deepEqual(result,[current])
  } finally {f.db.close()}
})
test('archive order and duplicate retry cannot replace source priority or duplicate symbols',async()=>{
  const f=fixture()
  try {
    await f.add('a',[row({id:2,source:'s12_candidate_snapshot_reconstruction',ready:0})])
    await f.add('b',[row()]);await f.add('c',[row()])
    const result=await mergeArchivedS12Evidence(f.env,f.adapter,DATE,['2330'],[])
    assert.equal(result.length,1);assert.equal(result[0].source,'s12_candidate_snapshot');assert.equal(result[0].ready,1)
  } finally {f.db.close()}
})
test('checksum, release evidence and conflicting versions fail visibly',async()=>{
  for(const mode of ['checksum','release','conflicting']) {
    const f=fixture()
    try {
      await f.add('a',[row()],{released:mode!=='release',corrupt:mode==='checksum'})
      if(mode==='conflicting')await f.add('b',[row({ready:0})])
      await assert.rejects(mergeArchivedS12Evidence(f.env,f.adapter,DATE,['2330'],[]),new RegExp(mode))
    } finally {f.db.close()}
  }
})
test('date coverage and requested symbols do not import unrelated historical evidence',async()=>{
  const f=fixture()
  try {
    await f.add('old',[row({trade_date:'2024-01-01'})],{metadata:{coverage_start:'2024-01-01',coverage_end:'2024-01-01'}})
    await f.add('other',[row({symbol:'2317'})])
    assert.deepEqual(await mergeArchivedS12Evidence(f.env,f.adapter,DATE,['2330'],[]),[])
    assert.equal(f.reads,1)
  } finally {f.db.close()}
})
test('manifest pagination does not truncate archives at the first 100 objects',async()=>{
  const f=fixture()
  try {
    for(let i=0;i<101;i++)await f.add(String(i).padStart(3,'0'),[row()])
    assert.equal((await mergeArchivedS12Evidence(f.env,f.adapter,DATE,['2330'],[])).length,1)
    assert.equal(f.reads,101)
  } finally {f.db.close()}
})

test('multiple hot pages share one archive download pass',async()=>{
  const f=fixture()
  try {
    await f.add('a',[row()])
    const candidates:any[]=[{symbol:'2330'},...Array.from({length:160},(_,i)=>({symbol:'other-'+i}))]
    const result=await hydrateS12StrategyEvidence(f.adapter,DATE,candidates,f.env)
    assert.equal(result.available,1);assert.equal(result.missing,160)
    assert.equal(f.reads,1)
  } finally {f.db.close()}
})
