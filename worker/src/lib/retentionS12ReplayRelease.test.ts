import { terminalReplaySymbols, loadSignedReplayRepairSymbolSet } from './s12ReplaySplitReadModels'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { releaseArchivedRows } from './retentionSourceRelease'
import { buildReplayCompactPayload, REPLAY_COMPACT_DOMAIN, REPLAY_COMPACT_SCHEMA, type ReplayReleaseProjection } from './retentionS12ReplayProjection'
import { archivedS12ReplayChunks } from './retentionS12ReplayReader'
import { readReleasedReplayPage, type ReplayReadCheckpoint } from './retentionS12ReplayPages'
import { loadS12ReplayRewardDates, S12_REWARD_HOT_SQL } from './s12ReplayRewardHistory'
import { persistS12ReplayOutcome } from './s12ReplayTradeOutcome'
import { S12_REPLAY_ENGINE_SIGNATURE as ENGINE } from './s12ReplayContract'
import { sha256Text } from './datasetSnapshots'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS as COST } from './canonicalSelectionLabels'
import type { RetentionArchiveSource } from './retentionArchiveOnly'
import type { EvidenceArtifactManifest } from './evidenceArtifactContract'

const schema = readFileSync('domain-schemas/learning.sql','utf8')
const ddl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS s12_replay_trade_outcomes')).split(';')[0]
const source: RetentionArchiveSource = {datasetId:'s12_replay_trade_outcomes',sourceDomain:'learning',
  fromSql:'s12_replay_trade_outcomes',selectSql:'s12_replay_trade_outcomes.*',keyExpression:'s12_replay_trade_outcomes.rowid',
  dateExpression:'s12_replay_trade_outcomes.trade_date',eligibilitySql:'1=1',deleteTable:'s12_replay_trade_outcomes',deleteKeyColumn:'rowid'}

export function replayReleaseFixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys=ON;'+ddl)
  sql.exec(`CREATE UNIQUE INDEX signal_key ON s12_replay_trade_outcomes(symbol,signal_date,setup_id) WHERE signal_date IS NOT NULL;
    CREATE TABLE allocator_ev_daily_lifecycle(business_date TEXT PRIMARY KEY,state TEXT,updated_at TEXT,upstream_run_id TEXT);
    CREATE TABLE run_artifacts(artifact_id TEXT PRIMARY KEY,domain TEXT,r2_key TEXT,checksum TEXT,row_count INTEGER,byte_size INTEGER,
      schema_version TEXT,metadata_json TEXT,retention_class TEXT,status TEXT,payload_deleted_at TEXT,created_at TEXT);
    CREATE TABLE data_retention_run_items(status TEXT,deleted_rows INTEGER,evidence_json TEXT,completed_at TEXT);`)
  for (const migration of ['0050_retention_source_release.sql','0056_s12_replay_reward_covering_index.sql','0057_s12_replay_cold_release.sql'])
    sql.exec(readFileSync('domain-migrations/learning/'+migration,'utf8'))
  const objects = new Map<string,string>(), downloads:string[]=[], queries:string[]=[]
  let calls=0, fail='', lose=false
  function prepare(query:string) {
    queries.push(query)
    let params:any[]=[]
    return {query,get params(){return params},bind(...values:any[]){params=values;return this},
      async first(){calls++;return sql.prepare(query).get(...params)??null},
      async all(){calls++;return {results:sql.prepare(query).all(...params)}},
      async run(){calls++;const r=sql.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}}
  }
  const db = {prepare,async batch(statements:any[]) {
    calls++;sql.exec('BEGIN')
    try {
      const result=statements.map(s=>{
        if(fail && s.query.includes(fail))throw new Error('injected '+fail)
        const q=sql.prepare(s.query)
        return {results:q.columns().length?q.all(...s.params):(q.run(...s.params),[])}
      })
      sql.exec('COMMIT');if(lose)throw new Error('lost HTTP acknowledgement');return result
    } catch(error){if(sql.isTransaction)sql.exec('ROLLBACK');throw error}
  }} as unknown as D1Database
  const env={DB:db,ARTIFACTS:{async get(key:string){downloads.push(key);const raw=objects.get(key)
    return raw===undefined?null:{size:Buffer.byteLength(raw),text:async()=>raw}}}} as any
  function insert(r:Record<string,any>) {sql.prepare(`INSERT INTO s12_replay_trade_outcomes(${Object.keys(r).join(',')})
    VALUES(${Object.keys(r).map(()=>'?').join(',')})`).run(...Object.values(r))}
  function rows() {return sql.prepare('SELECT id __cursor_key,trade_date __archive_date,* FROM s12_replay_trade_outcomes ORDER BY id').all() as any[]}
  async function seal(name:string, rows:Record<string,any>[]) {
    const domain='retention_learning_lineage_v1_s12_replay_trade_outcomes',version='d1-retention-hot-window-drain-v1'
    const raw=JSON.stringify({schema_version:version,domain,payload:{schema_version:version,policy_id:'learning_lineage_v1',
      dataset_id:source.datasetId,source_domain:'learning',cutoff_date:'2026-09-01',source_schema_sql:ddl,rows}})
    const artifact={artifact_id:name,checksum:await sha256Text(raw)}
    const payload=await buildReplayCompactPayload(rows,artifact)
    const body=JSON.stringify({schema_version:REPLAY_COMPACT_SCHEMA,domain:REPLAY_COMPACT_DOMAIN,payload})
    const projection:EvidenceArtifactManifest={artifact_id:name+':compact',checksum:await sha256Text(body),row_count:rows.length,
      byte_size:Buffer.byteLength(body),r2_key:name+':compact',status:'ready',retention_class:'ten_year_cold_archive',
      schema_version:REPLAY_COMPACT_SCHEMA,domain:REPLAY_COMPACT_DOMAIN,business_date:'2026-09-26',producer_run_id:name,
      canonical_run_id:null,created_at:'2026-09-26T00:00:00Z',retain_until:'2036-09-23',checksum_verified_at:'2026-09-26',metadata_json:'{}'}
    objects.set(name,raw);objects.set(projection.r2_key,body)
    sql.prepare('INSERT INTO run_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)')
      .run(name,domain,name,artifact.checksum,rows.length,Buffer.byteLength(raw),version,'{}','ten_year_cold_archive','ready','2026-09-26T00:00:00Z')
    const compact:ReplayReleaseProjection={source_artifact_id:name,source_checksum:artifact.checksum,rows_checksum:payload.rows_checksum,projection}
    return {artifact,compact,rows,release:()=>releaseArchivedRows(db,source,'2026-09-01',rows,artifact,compact)}
  }
  function count(table:string) {return Number(sql.prepare('SELECT COUNT(*) n FROM '+table).get()?.n)}
  return {sql,db,env,objects,downloads,queries,insert,rows,seal,count,get calls(){return calls},failAt(value:string){fail=value},loseAck(){lose=true}}
}

function sourceRow(id:number, patch:Record<string,any>={}) {
  return {id,symbol:String(2300+id),market:'LISTED',signal_date:'2026-06-01',trade_date:'2026-06-02',setup_id:'setup'+id,
    sample_eligible:1,pnl_pct:(id%7-2)*.012,source:'s12_multisession_structure_replay_v3',detail_json:JSON.stringify({
      schema_version:'s12-replay-trade-outcome-v3',observation_kind:'executed',
      replay_diagnostics:{replay_engine_signature:ENGINE,outcome_known_date:'2026-06-10'}}),...patch}
}
const COLD_TABLES=['s12_replay_cold_batches_v1','s12_replay_cold_identities_v1','s12_replay_cold_rewards_v1','learning_retention_releases_v1']

async function coldRows(f:ReturnType<typeof replayReleaseFixture>) {
  const rows:any[]=[]
  for await (const chunk of archivedS12ReplayChunks(f.env,f.db,'2026-01-01','2026-09-26','2026-09-26T02:00:00Z')) rows.push(...chunk)
  return rows
}

function assertDateParity(expected:Record<string,any>[],actual:Record<string,any>[]) {
  assert.equal(actual.length,expected.length)
  for(let i=0;i<expected.length;i++) {
    for(const key of ['date','outcome_known_date','samples','hits'])assert.equal(actual[i][key],expected[i][key],key)
    for(const key of ['reward_sum','date_return'])assert.ok(Math.abs(actual[i][key]-expected[i][key])<1e-12,key)
  }
}

test('every partial release failure and concurrent source edit roll back identities, rewards, deletion and proof',async()=>{
  for(const failure of ['INSERT INTO s12_replay_cold_batches_v1','INSERT INTO s12_replay_cold_identities_v1',
    'INSERT INTO s12_replay_cold_rewards_v1','DELETE FROM','INSERT INTO learning_retention_releases_v1','source_edit']) {
    const f=replayReleaseFixture()
    try {
      f.insert(sourceRow(1));f.insert(sourceRow(2));const sealed=await f.seal('raw',f.rows())
      if(failure==='source_edit')f.sql.exec('UPDATE s12_replay_trade_outcomes SET pnl_pct=.99 WHERE id=2')
      else f.failAt(failure)
      await assert.rejects(sealed.release())
      assert.equal(f.count('s12_replay_trade_outcomes'),2)
      for(const table of COLD_TABLES)assert.equal(f.count(table),0,table)
      assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[])
    }finally{f.sql.close()}
  }
})

test('lost acknowledgement retry is idempotent, frozen state immutable, changed proof cannot be accepted',async()=>{
  const f=replayReleaseFixture()
  try {
    f.insert(sourceRow(1));f.insert(sourceRow(2));const sealed=await f.seal('raw',f.rows());f.loseAck()
    await assert.rejects(sealed.release(),/lost HTTP/)
    assert.equal(await sealed.release(),2)
    assert.equal(f.count('s12_replay_trade_outcomes'),0);assert.equal(f.count('s12_replay_cold_rewards_v1'),1)
    assert.equal(f.count('s12_replay_cold_identities_v1'),2)
    for(const table of COLD_TABLES) {
      assert.throws(()=>f.sql.exec('DELETE FROM '+table),/immutable/)
      assert.throws(()=>f.sql.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),/immutable/)
    }
    await assert.rejects(releaseArchivedRows(f.db,source,'2026-09-01',sealed.rows,sealed.artifact,
      {...sealed.compact,projection:{...sealed.compact.projection,r2_key:'wrong'}}),/saved_projection_conflict/)
    assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[])
  }finally{f.sql.close()}
})

test('missing or changed compact proof cannot release source rows',async()=>{
  const f=replayReleaseFixture()
  try {
    f.insert(sourceRow(1));const sealed=await f.seal('raw',f.rows())
    await assert.rejects(releaseArchivedRows(f.db,source,'2026-09-01',sealed.rows,sealed.artifact),/projection_required/)
    await assert.rejects(releaseArchivedRows(f.db,source,'2026-09-01',sealed.rows,sealed.artifact,
      {...sealed.compact,rows_checksum:'changed'}),/projection_required/)
    assert.equal(f.count('s12_replay_trade_outcomes'),1)
    assert.equal(f.count('s12_replay_cold_batches_v1'),0)
  }finally{f.sql.close()}
})

test('hot/mixed/cold rewards match original SQL across unequal groups, engine, eligibility, fees and as-of clocks',async()=>{
  for(const hotCount of [37,11,0]) {
    const f=replayReleaseFixture()
    try {
      for(let id=1;id<=37;id++) {
        const r=sourceRow(id,{signal_date:'2026-06-0'+(id%3+1),pnl_pct:[-.1,0,.0018,.001800001,.03,.2][id%6]})
        const d=JSON.parse(r.detail_json)
        if(id%5===0)d.replay_diagnostics.outcome_known_date='2026-06-30T23:30:00-02:00'
        if(id%7===0)d.replay_diagnostics.replay_engine_signature='old-engine'
        if(id%11===0)d.observation_kind='unavailable'
        if(id%13===0)r.sample_eligible=0
        if(id%17===0)r.pnl_pct=null
        if(id%19===0)d.replay_diagnostics.outcome_known_date='invalid'
        if(id%23===0)r.source='legacy'
        if(id%29===0)d.schema_version='old'
        r.detail_json=JSON.stringify(d);f.insert(r)
      }
      const dates=['2026-06-09','2026-06-10','2026-06-30','2026-07-01','2026-12-31']
      const expected=dates.map(d=>f.sql.prepare(S12_REWARD_HOT_SQL).all(COST,COST,COST,d,ENGINE,d))
      const releaseRows=f.rows().slice(hotCount)
      for(let offset=0;offset<releaseRows.length;offset+=7)await (await f.seal('raw'+offset,releaseRows.slice(offset,offset+7))).release()
      const before=f.calls
      for(let i=0;i<dates.length;i++)assertDateParity(expected[i],await loadS12ReplayRewardDates(f.db,dates[i]))
      assert.equal(f.calls-before,dates.length,'one DB statement per read, independent of archive count')
      assert.deepEqual(f.downloads,[],'reward reads must not scan R2 history')
    }finally{f.sql.close()}
  }
})

test('legacy release without derived state and a changed fee basis fail rather than omit history',async()=>{
  for(const problem of ['legacy','cost','wrong_owner']) {
    const f=replayReleaseFixture()
    try {
      if(problem==='legacy')f.sql.prepare('INSERT INTO learning_retention_releases_v1 VALUES(?,?,?,?,CURRENT_TIMESTAMP)')
        .run('legacy','sha256:x','s12_replay_trade_outcomes',1)
      else {
        f.insert(sourceRow(1));await (await f.seal('raw',f.rows())).release()
        // Simulate a prior software release with a different fee basis; normal writes cannot mutate this.
        if(problem==='cost')f.sql.exec('DROP TRIGGER s12_replay_cold_batches_v1_immutable_update; UPDATE s12_replay_cold_batches_v1 SET cost_bps=19')
        else f.sql.exec("DROP TRIGGER learning_retention_releases_v1_immutable_update; UPDATE learning_retention_releases_v1 SET dataset_id='wrong_owner'")
      }
      await assert.rejects(loadS12ReplayRewardDates(f.db,'2026-09-26'),/history_incomplete_or_cost_mismatch/)
    }finally{f.sql.close()}
  }
})

function producerOutcome() {
  return {schema_version:'s12-replay-trade-outcome-v3',symbol:'2330',signal_date:'2026-06-01',trade_date:'2026-06-02',market:'LISTED',
    status:'executed',observation_kind:'executed',sample_eligible:true,source:'s12_multisession_structure_replay_v3',
    assessment_state:'reaction_ready',status_reason:'executed_reaction_ready',setup_id:'setup1',entry_ms:1000,exit_ms:2000,
    entry_price:100,stop_price:98,target1_price:102,target2_price:104,target3_price:106,exit_price:104,pnl_pct:.04,
    trade_pnl_r:2,mfe_pct:.05,mae_pct:-.01,bars_to_exit:2,exit_reason:'tp2',conservative_intrabar_order:'stop_before_target',
    replay_diagnostics:{replay_engine_signature:ENGINE,entry_policy_signature:'reaction_ready',exit_calibration_signature:'uncalibrated',
      replay_cohort_signature:ENGINE+'|entry=reaction_ready|calibration=uncalibrated',outcome_known_date:'2026-06-10'}} as any
}

test('producer retry after release acknowledges identical evidence; changed content requires explicit revision and lease stays enforced',async()=>{
  const f=replayReleaseFixture()
  try {
    const outcome=producerOutcome()
    f.sql.exec("INSERT INTO allocator_ev_daily_lifecycle VALUES('2026-06-01','replay_complete','2026-09-25','owner')")
    let before=f.calls
    assert.equal(await persistS12ReplayOutcome(f.db,outcome,{expectedLifecycleRunId:'owner'}),true)
    assert.equal(f.calls-before,2,'original insert + retry cleanup only')
    const sealed=await f.seal('raw',f.rows());await sealed.release()
    before=f.calls
    assert.equal(await persistS12ReplayOutcome(f.db,outcome,{expectedLifecycleRunId:'owner'}),true)
    assert.equal(f.calls-before,2,'trigger rejection + one cold acknowledgement, no reinsert/cleanup')
    assert.equal(f.count('s12_replay_trade_outcomes'),0)
    assert.equal(await persistS12ReplayOutcome(f.db,outcome,{expectedLifecycleRunId:'other'}),false)
    await assert.rejects(persistS12ReplayOutcome(f.db,{...outcome,pnl_pct:.05}),/archived_revision_requires_rebuild/)
    assert.equal(f.count('s12_replay_cold_identities_v1'),1)
    assert.equal(f.count('s12_replay_cold_rewards_v1'),1)
    assert.equal(await persistS12ReplayOutcome(f.db,{...outcome,symbol:'9999'}),true,'same day other identity remains writable')
  }finally{f.sql.close()}
})

test('database guards both natural keys, explicit id reuse and update, retaining NULL uniqueness semantics',async()=>{
  const f=replayReleaseFixture()
  try {
    f.insert(sourceRow(1));f.insert(sourceRow(2,{setup_id:null}));const sealed=await f.seal('raw',f.rows());await sealed.release()
    assert.throws(()=>f.insert(sourceRow(1,{symbol:'other'})),/archived_key/)
    assert.throws(()=>f.insert(sourceRow(3,{symbol:'2301',setup_id:'setup1',signal_date:'2026-06-03'})),/archived_key/)
    assert.throws(()=>f.insert(sourceRow(3,{symbol:'2301',setup_id:'setup1',trade_date:'2026-06-03'})),/archived_key/)
    f.insert(sourceRow(3,{symbol:'2302',setup_id:null}))
    assert.throws(()=>f.sql.exec("UPDATE s12_replay_trade_outcomes SET symbol='2301',setup_id='setup1' WHERE id=3"),/archived_key/)
    assert.equal(f.count('s12_replay_trade_outcomes'),1)
  }finally{f.sql.close()}
})

test('compact reader downloads no large raw trace, verifies source/identity/checksum, and retains hard limits',async()=>{
  for(const problem of ['none','checksum','source','identity','missing']) {
    const f=replayReleaseFixture()
    try {
      const r=sourceRow(1),detail=JSON.parse(r.detail_json);detail.trace='x'.repeat(700000);r.detail_json=JSON.stringify(detail)
      f.insert(r);const sealed=await f.seal('raw',f.rows());await sealed.release()
      assert.ok(sealed.compact.projection.byte_size<2048)
      const key=sealed.compact.projection.r2_key
      if(problem==='checksum')f.objects.set(key,f.objects.get(key)!.replace('executed','rejected'))
      if(problem==='missing')f.objects.delete(key)
      if(problem==='source'||problem==='identity') {
        const body=JSON.parse(f.objects.get(key)!)
        if(problem==='source')body.payload.source_artifact_id='another'
        else body.payload.rows[0].symbol='9999'
        const raw=JSON.stringify(body);f.objects.set(key,raw)
        f.sql.exec('DROP TRIGGER s12_replay_cold_batches_v1_immutable_update')
        f.sql.prepare('UPDATE s12_replay_cold_batches_v1 SET projection_checksum=?,projection_bytes=?')
          .run(await sha256Text(raw),Buffer.byteLength(raw))
      }
      if(problem==='none') {
        const got=await coldRows(f);assert.equal(got.length,1);assert.equal(got[0].pnl_pct,r.pnl_pct)
        assert.ok(!got[0].detail_json.includes('trace'))
      }else await assert.rejects(coldRows(f),/checksum_mismatch|compact_payload_mismatch|compact_identity_mismatch|archive_missing/)
      assert.deepEqual(f.downloads,[key])
    }finally{f.sql.close()}
  }
})

test('cold schema migration is additive/idempotent and owner schema includes exact definitions',()=>{
  const f=replayReleaseFixture()
  try {
    const migration=readFileSync('domain-migrations/learning/0057_s12_replay_cold_release.sql','utf8')
    f.sql.exec(migration);assert.ok(schema.includes(migration.trim()))
  }finally{f.sql.close()}
})


test('live completion and signed-repair queries preserve cross hot/cold status and avoid redundant replay',async()=>{
  for(const hotCount of [9,4,0]) {
    const f=replayReleaseFixture()
    try {
      for(let id=1;id<=9;id++) {
        const r=sourceRow(id),d=JSON.parse(r.detail_json)
        Object.assign(d.replay_diagnostics,{entry_policy_signature:'Reaction_Ready',exit_calibration_signature:'uncalibrated',
          replay_cohort_signature:ENGINE+'|entry=reaction_ready|calibration=uncalibrated'})
        if(id===1||id===7)d.replay_diagnostics.replay_engine_signature='old-engine'
        if(id===3||id===4) {
          r.sample_eligible=0;d.lineage_validation={previous_sample_eligible:1,status:'signed_repair_terminal_noneligible'}
          if(id===4)d.replay_diagnostics.outcome_known_date='invalid'
        }
        if(id===5||id===6) {
          r.sample_eligible=0;d.observation_kind='unavailable'
          d.status_reason=id===5?'missing_intraday_bars':'terminal_non_trade'
        }
        if(id===7)r.source='older-source'
        if(id===8){r.symbol='2301';r.setup_id='replacement-for-1'}
        if(id===9)r.signal_date='2026-05-01'
        r.detail_json=JSON.stringify(d);f.insert(r)
      }
      const rows=f.rows().slice(hotCount)
      if(rows.length)await (await f.seal('raw',rows)).release()
      const before=f.calls
      const terminal=await terminalReplaySymbols(f.env,'2026-06-01',['2301','2302','2303','2304','2305','2306','2307','2309'])
      assert.deepEqual([...terminal].sort(),['2301','2302','2303','2304','2306'])
      assert.deepEqual([...await loadSignedReplayRepairSymbolSet(f.db,'2026-06-01')].sort(),['2304','2307'])
      assert.equal(f.calls-before,2,'one bounded SQL per status request')
      assert.deepEqual(f.downloads,[])
    }finally{f.sql.close()}
  }
})

test('status queries reject missing cold derived state instead of queueing an incomplete population',async()=>{
  const f=replayReleaseFixture()
  try {
    f.sql.prepare('INSERT INTO learning_retention_releases_v1 VALUES(?,?,?,?,CURRENT_TIMESTAMP)')
      .run('legacy','sha256:x','s12_replay_trade_outcomes',1)
    await assert.rejects(terminalReplaySymbols(f.env,'2026-06-01',['2330']),/status_history_incomplete/)
    await assert.rejects(loadSignedReplayRepairSymbolSet(f.db,'2026-06-01'),/status_history_incomplete/)
  }finally{f.sql.close()}
})


test('161 cold symbols use one completion query and no archive downloads',async()=>{
  const f=replayReleaseFixture()
  try {
    for(let id=1;id<=161;id++)f.insert(sourceRow(id))
    await (await f.seal('raw',f.rows())).release()
    const before=f.calls
    const symbols=Array.from({length:170},(_,i)=>String(2301+i))
    assert.equal((await terminalReplaySymbols(f.env,'2026-06-01',symbols)).size,161)
    assert.equal(f.calls-before,1);assert.deepEqual(f.downloads,[])
  }finally{f.sql.close()}
})


const PAGE_INPUT={startDate:'2026-01-01',endDate:'2026-09-26',snapshotAt:'2026-09-27T00:00:00Z'}

test('312 immutable cold batches finish through bounded pages beyond the synchronous 256-file guard',async()=>{
  const f=replayReleaseFixture()
  try {
    for(let id=1;id<=312;id++) {
      f.insert(sourceRow(id));await (await f.seal('raw-'+String(id).padStart(4,'0'),f.rows())).release()
    }
    await assert.rejects(coldRows(f),/budget_exceeded:detached_reader_required/)
    assert.equal(f.downloads.length,256,'the synchronous safety limit stays enforced')
    f.downloads.length=0;f.queries.length=0
    let checkpoint:ReplayReadCheckpoint|undefined,complete=false,pages=0
    const collected:any[]=[]
    while(!complete) {
      const page=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint,maxManifests:7,maxBytes:16*1024,maxSourceRows:10})
      assert.ok(page.page.manifests<=7);assert.ok(page.page.bytes<=16*1024);assert.ok(page.page.sourceRows<=10)
      assert.ok(page.rows.length<=10)
      collected.push(...page.rows);complete=page.complete;checkpoint=JSON.parse(JSON.stringify(page.checkpoint));pages++
      assert.ok(pages<=46,'every checkpoint must make progress')
    }
    assert.equal(pages,45);assert.equal(checkpoint?.manifestsRead,312);assert.equal(checkpoint?.sourceRowsRead,312)
    assert.equal(checkpoint?.afterRowid,checkpoint?.upperRowid)
    assert.deepEqual(collected.map(r=>r.id),Array.from({length:312},(_,i)=>i+1))
    for(const row of collected)assert.equal(row.pnl_pct,sourceRow(row.id).pnl_pct)
    assert.equal(new Set(f.downloads).size,312);assert.equal(f.downloads.length,312,'one compact download per batch, no rescans')
    assert.equal(f.queries.filter(q=>q.includes('FROM data_retention_run_items')).length,0,'modern releases never scan Ops JSON audit history')
    assert.equal(f.queries.filter(q=>q.startsWith('SELECT 1 invalid FROM')).length,2,'whole-catalog integrity scans only at start/end')
    assert.equal(f.queries.filter(q=>q.startsWith('SELECT COALESCE(MAX(rowid)')).length,2,'whole-catalog counts only at start/end')
    const lookup=f.queries.find(q=>q.includes('FROM run_artifacts a'))!
    const plan=f.sql.prepare('EXPLAIN QUERY PLAN '+lookup).all('retention_learning_lineage_v1_s12_replay_trade_outcomes',
      'd1-retention-hot-window-drain-v1','','2026-09-27','raw-0001',PAGE_INPUT.startDate,PAGE_INPUT.endDate)
    assert.ok(plan.some(r=>String(r.detail).includes('(artifact_id=?)')),'each manifest lookup must use its primary key')
    const end=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint})
    assert.equal(end.complete,true);assert.deepEqual(end.rows,[]);assert.deepEqual(end.checkpoint,checkpoint)
  }finally{f.sql.close()}
})

test('serialized checkpoints replay the same page and freeze concurrent earlier-sorting releases out',async()=>{
  const f=replayReleaseFixture()
  try {
    for(let id=1;id<=3;id++){f.insert(sourceRow(id));await (await f.seal('z-'+id,f.rows())).release()}
    const first=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,maxManifests:1})
    assert.deepEqual(first.rows.map(r=>r.id),[1]);assert.equal(first.complete,false)
    const saved=JSON.parse(JSON.stringify(first.checkpoint))
    const before=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:saved,maxManifests:1})
    f.insert(sourceRow(4));await (await f.seal('000-new-release',f.rows())).release()
    const replay=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:saved,maxManifests:1})
    assert.deepEqual(replay,before,'new inventory cannot reorder or extend a frozen session')
    const final=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:replay.checkpoint,maxManifests:1})
    assert.equal(final.complete,true);assert.deepEqual(final.rows.map(r=>r.id),[3]);assert.equal(final.checkpoint.sourceRowsRead,3)
    const fresh=await readReleasedReplayPage(f.env,f.db,PAGE_INPUT)
    assert.equal(fresh.complete,true);assert.equal(fresh.rows.length,4)
  }finally{f.sql.close()}
})

test('checkpoint/window/inventory failures and legacy incomplete releases reject before any archive fetch',async()=>{
  const f=replayReleaseFixture()
  try {
    for(let id=1;id<=2;id++){f.insert(sourceRow(id));await (await f.seal('raw-'+id,f.rows())).release()}
    const first=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,maxManifests:1})
    const count=f.downloads.length
    for(const patch of [{afterRowid:2},{sourceRowsRead:9},{checksum:'invalid'},{snapshotAt:'invalid'}])
      await assert.rejects(readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:{...first.checkpoint,...patch}}),/checkpoint_invalid/)
    await assert.rejects(readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,endDate:'2026-08-01',checkpoint:first.checkpoint}),/checkpoint_invalid/)
    assert.equal(f.downloads.length,count)
    assert.throws(()=>f.sql.exec('UPDATE s12_replay_cold_batches_v1 SET rowid=100 WHERE rowid=1'),/immutable/)
    f.sql.exec('DROP TRIGGER s12_replay_cold_batches_v1_immutable_update; UPDATE s12_replay_cold_batches_v1 SET rowid=100 WHERE rowid=1')
    await assert.rejects(readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:first.checkpoint}),/frozen_inventory_changed/)
    assert.equal(f.downloads.length,count)
    f.sql.exec("INSERT INTO learning_retention_releases_v1 VALUES('legacy','sha256:x','s12_replay_trade_outcomes',1,CURRENT_TIMESTAMP)")
    await assert.rejects(readReleasedReplayPage(f.env,f.db,PAGE_INPUT),/legacy_or_incomplete_history/)
    assert.equal(f.downloads.length,count)
  }finally{f.sql.close()}
})

test('page byte/row budgets preserve an unconsumed batch and an oversized first batch fails explicitly',async()=>{
  const f=replayReleaseFixture()
  try {
    f.insert(sourceRow(1));f.insert(sourceRow(2));const first=await f.seal('raw-1',f.rows());await first.release()
    f.insert(sourceRow(3));const second=await f.seal('raw-2',f.rows());await second.release()
    const one=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,maxSourceRows:2,maxBytes:first.compact.projection.byte_size})
    assert.equal(one.complete,false);assert.deepEqual(one.rows.map(r=>r.id),[1,2])
    const two=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:one.checkpoint,maxSourceRows:2,maxBytes:first.compact.projection.byte_size})
    assert.equal(two.complete,true);assert.deepEqual(two.rows.map(r=>r.id),[3])
    assert.equal(two.checkpoint.bytesRead,first.compact.projection.byte_size+second.compact.projection.byte_size)
    const count=f.downloads.length
    await assert.rejects(readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,maxSourceRows:1}),/single_batch_exceeds_budget/)
    await assert.rejects(readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,maxBytes:first.compact.projection.byte_size-1}),/single_batch_exceeds_budget/)
    assert.equal(f.downloads.length,count)
  }finally{f.sql.close()}
})

test('failed cold pages leave the saved checkpoint unchanged and recover without omitting a batch',async()=>{
  for(const problem of ['missing','checksum','manifest']) {
    const f=replayReleaseFixture()
    try {
      for(let id=1;id<=3;id++){f.insert(sourceRow(id));await (await f.seal('raw-'+id,f.rows())).release()}
      const first=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,maxManifests:1})
      const saved=JSON.stringify(first.checkpoint),payload=f.objects.get('raw-2:compact')!
      if(problem==='missing')f.objects.delete('raw-2:compact')
      else if(problem==='checksum')f.objects.set('raw-2:compact',payload.replace('executed','rejected'))
      else f.sql.exec("UPDATE run_artifacts SET status='quarantined' WHERE artifact_id='raw-2'")
      await assert.rejects(readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:first.checkpoint}),/archive_missing|checksum_mismatch|snapshot_manifest_missing/)
      assert.equal(JSON.stringify(first.checkpoint),saved)
      f.objects.set('raw-2:compact',payload);f.sql.exec("UPDATE run_artifacts SET status='ready' WHERE artifact_id='raw-2'")
      const recovered=await readReleasedReplayPage(f.env,f.db,{...PAGE_INPUT,checkpoint:first.checkpoint})
      assert.deepEqual(recovered.rows.map(r=>r.id),[2,3]);assert.equal(recovered.complete,true)
      assert.equal(recovered.checkpoint.sourceRowsRead,3)
    }finally{f.sql.close()}
  }
})
