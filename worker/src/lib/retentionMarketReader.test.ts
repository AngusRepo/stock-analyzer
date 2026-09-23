import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { mergeArchivedMarketHistory } from './retentionMarketReader'
import { sha256Text } from './datasetSnapshots'

async function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE run_artifacts(artifact_id TEXT,domain TEXT,r2_key TEXT,checksum TEXT,row_count INTEGER,byte_size INTEGER,schema_version TEXT,metadata_json TEXT,retention_class TEXT,status TEXT,payload_deleted_at TEXT);
    CREATE TABLE data_retention_run_items(status TEXT,deleted_rows INTEGER,evidence_json TEXT,completed_at TEXT);
    CREATE TABLE market_retention_releases_v1(artifact_id TEXT,checksum TEXT,dataset_id TEXT,row_count INTEGER);
    CREATE TABLE canonical_fundamental_features(stock_id TEXT,period TEXT,source TEXT,as_of_date TEXT);`)
  const objects = new Map<string,string>(); let reads = 0
  const adapter = {prepare(sql:string) {let params:any[]=[];return {
    bind(...args:any[]) {params=args;return this},
    async all() {return {results:db.prepare(sql).all(...params)}},
    async first() {return db.prepare(sql).get(...params) ?? null},
  }}}
  const env = {DB:adapter, ARTIFACTS:{async get(key:string) {reads++; const raw=objects.get(key);return raw===undefined?null:{size:Buffer.byteLength(raw),text:async()=>raw}}}} as any
  async function add(id:string,rows:any[],options:{released?:boolean, metadata?:object, corrupt?:boolean,table?:string}={}) {
    const table=options.table ?? 'stock_prices', schema='d1-retention-hot-window-drain-v1',domain='retention_canonical_market_hot_v1_'+table
    const body={domain,schema_version:schema,payload:{schema_version:schema,source_domain:'market',dataset_id:table,policy_id:'canonical_market_hot_v1',cutoff_date:'2026-01-01',rows:rows.map((r,i)=>({...r,__cursor_key:i+1,__archive_date:r.date ?? r.available_date}))}}
    const raw=JSON.stringify(body),checksum=await sha256Text(raw)
    objects.set(id,options.corrupt?'corrupt':raw)
    db.prepare('INSERT INTO run_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,domain,id,checksum,rows.length,Buffer.byteLength(raw),schema,JSON.stringify(options.metadata??{}),'ten_year_cold_archive','ready')
    if(options.released!==false) db.prepare('INSERT INTO market_retention_releases_v1 VALUES(?,?,?,?)').run(id,checksum,table,rows.length)
  }
  return {db,env,add,get reads(){return reads}}
}

test('cold history restores dates and preserves recovered hot values with natural keys',async()=>{
  const f=await fixture()
  try {
    await f.add('a',[{id:1,stock_id:1,date:'2020-01-01',close:10},{id:2,stock_id:1,date:'2020-01-02',close:11},{id:3,stock_id:2,date:'2020-01-01',close:99}])
    const hot=[{id:200,stock_id:1,date:'2020-01-02',close:12}]
    const rows=await mergeArchivedMarketHistory(f.env,'stock_prices',1,'2020-01-01',hot)
    assert.deepEqual(rows,[{id:1,stock_id:1,date:'2020-01-01',close:10},hot[0]])
    assert.equal(f.reads,1)
  } finally {f.db.close()}
})

test('coverage and stock metadata skip unrelated objects without truncating requested history',async()=>{
  const f=await fixture()
  try {
    await f.add('old',[{stock_id:1,date:'2019-01-01'}],{metadata:{coverage_start:'2019-01-01',coverage_end:'2019-01-01'}})
    await f.add('other',[{stock_id:2,date:'2020-01-01'}],{metadata:{stock_keys:[2]}})
    await f.add('wanted',[{stock_id:1,date:'2020-01-01'}])
    assert.equal((await mergeArchivedMarketHistory(f.env,'stock_prices',1,'2020-01-01',[])).length,1)
    assert.equal(f.reads,1)
  } finally {f.db.close()}
})

test('checksum, release proof and conflicting revisions fail visibly',async()=>{
  for(const mode of ['corrupt','unreleased','conflict']) {
    const f=await fixture()
    try {
      await f.add('a',[{stock_id:1,date:'2020-01-01',close:10}],{corrupt:mode==='corrupt',released:mode!=='unreleased'})
      if(mode==='conflict') await f.add('b',[{stock_id:1,date:'2020-01-01',close:11}])
      await assert.rejects(mergeArchivedMarketHistory(f.env,'stock_prices',1,'2020-01-01',[]),new RegExp(mode==='corrupt'?'checksum':mode==='unreleased'?'release_receipt':'conflicting'))
    } finally {f.db.close()}
  }
})

test('identical archive retry does not duplicate history, backup-only rows remain hot',async()=>{
  const f=await fixture()
  try {
    const rows=[{stock_id:1,date:'2020-01-01',close:10}]
    await f.add('a',rows);await f.add('b',rows)
    await f.add('backup',[{stock_id:1,date:'2020-01-02',close:10}],{released:false})
    const result=await mergeArchivedMarketHistory(f.env,'stock_prices',1,'2020-01-01',[{stock_id:1,date:'2020-01-02',close:12}])
    assert.equal(result.length,2);assert.equal(result[1].close,12)
  } finally {f.db.close()}
})


test('fundamental as-of reads preserve each source and cannot resurrect a newer hot revision',async()=>{
  const f=await fixture(),table='canonical_fundamental_features'
  try {
    const base={stock_id:'2330',period:'2020Q1',available_date:'2020-05-01',as_of_date:'2020-05-01',eps:1}
    await f.add('a',[{...base,source:'one'},{...base,source:'two',eps:2},{...base,source:'revised',eps:3},{...base,source:'future',as_of_date:'2020-07-01'}],{table})
    f.db.prepare('INSERT INTO canonical_fundamental_features VALUES(?,?,?,?)').run('2330','2020Q1','revised','2020-07-01')
    const rows=await mergeArchivedMarketHistory(f.env,table,'2330','0000-01-01',[],'2020-06-01',row=>String(row.as_of_date)<='2020-06-01')
    assert.deepEqual(rows.map(row=>row.source).sort(),['one','two'])
  } finally {f.db.close()}
})


test('legacy receipt accepts exact checksum and count only, without new source receipt',async()=>{
  for (const mode of ['valid','checksum','count','status']) {
    const f=await fixture()
    try {
      await f.add('legacy',[{stock_id:1,date:'2020-01-01',close:10}],{released:false})
      const manifest=f.db.prepare('SELECT checksum FROM run_artifacts').get() as any
      f.db.prepare('INSERT INTO data_retention_run_items VALUES(?,?,?,?)').run(
        mode==='status'?'error':'success',mode==='count'?0:1,
        JSON.stringify({artifact_id:'legacy',checksum:mode==='checksum'?'wrong':manifest.checksum}),'2026-08-23')
      const read=mergeArchivedMarketHistory(f.env,'stock_prices',1,'2020-01-01',[])
      if(mode==='valid') assert.equal((await read)[0].close,10)
      else await assert.rejects(read,/release_receipt/)
    } finally {f.db.close()}
  }
})
