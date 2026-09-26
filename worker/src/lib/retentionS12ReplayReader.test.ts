import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { archivedS12ReplayChunks, projectS12ReplayChunk, REPLAY_READ_BUDGET } from './retentionS12ReplayReader'
import { createS12CalibrationHistory, inspectS12TwCalibrationLifecycleCensoring, loadS12TwCalibrationEvidence } from './s12TwEquityCalibration'
import { sha256Text } from './datasetSnapshots'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'

const NOW = Date.parse('2026-09-26T02:00:00Z'), START = '2026-06-28', END = '2026-09-26'
const schema = readFileSync('domain-schemas/learning.sql','utf8')
const ddl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS s12_replay_trade_outcomes')).split(';')[0]
function row(id=1, patch:Record<string,any>={}) {
  return {id,symbol:String(2300+id),market:'LISTED',signal_date:'2026-08-01',trade_date:'2026-08-10',
    setup_id:'setup'+id,assessment_state:'reaction_ready',entry_ms:Date.parse('2026-08-10T01:30:00Z'),
    entry_price:100,stop_price:98,pnl_pct:.02,max_favorable_pct:.04,max_adverse_pct:-.01,sample_eligible:1,
    source:'s12_multisession_structure_replay_v3',created_at:'2026-08-20',detail_json:JSON.stringify({
      assessment_detail:'atr15m=2;equity_mutation_score=5;vwap_fast_reasons=reclaim|volume',market_segment:'LISTED',alpha_bucket:'high',
      replay_diagnostics:{replay_engine_signature:S12_REPLAY_ENGINE_SIGNATURE,replay_cohort_signature:'cohort1',outcome_known_date:'2026-08-20'}}),...patch}
}
function fixture() {
  const db=new DatabaseSync(':memory:');db.exec(ddl)
  db.exec(`CREATE UNIQUE INDEX signal_key ON s12_replay_trade_outcomes(symbol,signal_date,setup_id) WHERE signal_date IS NOT NULL;
    CREATE TABLE allocator_ev_daily_lifecycle(business_date TEXT PRIMARY KEY,state TEXT,updated_at TEXT);
    CREATE TABLE run_artifacts(artifact_id TEXT,domain TEXT,r2_key TEXT,checksum TEXT,row_count INTEGER,byte_size INTEGER,schema_version TEXT,metadata_json TEXT,retention_class TEXT,status TEXT,payload_deleted_at TEXT,created_at TEXT);
    CREATE TABLE data_retention_run_items(status TEXT,deleted_rows INTEGER,evidence_json TEXT,completed_at TEXT);
    CREATE TABLE learning_retention_releases_v1(artifact_id TEXT,checksum TEXT,dataset_id TEXT,row_count INTEGER);`)
  db.exec(`CREATE TABLE s12_replay_cold_batches_v1(artifact_id TEXT,source_checksum TEXT,row_count INTEGER,projection_bytes INTEGER,projection_key TEXT,projection_checksum TEXT,rows_checksum TEXT);`)
  const objects=new Map<string,string>();let reads=0;const sentSizes:number[]=[]
  const adapter={prepare(sql:string) {let params:any[]=[];return {bind(...args:any[]){params=args;return this},
    async all(){if(sql.startsWith('WITH retained_replay'))sentSizes.push(Buffer.byteLength(String(params[0])));return {results:db.prepare(sql).all(...params)}},
    async first(){return db.prepare(sql).get(...params)??null}}}}
  const env={DB:adapter,ARTIFACTS:{async get(key:string){reads++;const raw=objects.get(key);return raw===undefined?null:{size:Buffer.byteLength(raw),text:async()=>raw}}}} as any
  function hot(r:Record<string,any>) {db.prepare(`INSERT INTO s12_replay_trade_outcomes (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(()=>'?').join(',')})`).run(...Object.values(r))}
  function life(date='2026-08-01',state='replay_complete',updated='2026-09-25T00:00:00Z') {db.prepare('INSERT INTO allocator_ev_daily_lifecycle VALUES(?,?,?)').run(date,state,updated)}
  async function add(name:string,rows:Record<string,any>[],released=true,created='2026-09-25T00:00:00Z') {
    const schema='d1-retention-hot-window-drain-v1',domain='retention_learning_lineage_v1_s12_replay_trade_outcomes'
    const raw=JSON.stringify({domain,schema_version:schema,payload:{schema_version:schema,source_domain:'learning',policy_id:'learning_lineage_v1',dataset_id:'s12_replay_trade_outcomes',cutoff_date:'2026-09-26',source_schema_sql:ddl,rows:rows.map(r=>({...r,__cursor_key:r.id,__archive_date:r.trade_date}))}})
    const checksum=await sha256Text(raw);objects.set(name,raw)
    db.prepare('INSERT INTO run_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)').run(name,domain,name,checksum,rows.length,Buffer.byteLength(raw),schema,'{}','ten_year_cold_archive','ready',created)
    if(released)db.prepare('INSERT INTO learning_retention_releases_v1 VALUES(?,?,?,?)').run(name,checksum,'s12_replay_trade_outcomes',rows.length)
  }
  return {db,adapter:adapter as unknown as D1Database,env,objects,hot,life,add,sentSizes,get reads(){return reads}}
}
async function read(f:ReturnType<typeof fixture>) {const result:any[]=[];for await(const chunk of archivedS12ReplayChunks(f.env,f.adapter,START,END,new Date(NOW).toISOString()))result.push(...chunk);return result}

test('all-hot, mixed, all-cold calibration and censoring are identical; cold pass is shared',async()=>{
  let expected:any
  for(const hotCount of [8,3,0]) {
    const f=fixture()
    try {
      const rows=Array.from({length:8},(_,i)=>row(i+1,{signal_date:`2026-08-0${1+i%6}`}))
      f.life('2026-08-01');f.life('2026-08-02','replay_pending_maturity')
      f.life('2026-08-03','replay_enqueued','2026-09-26T01:00:00Z');f.life('2026-08-04','replay_enqueued')
      f.life('2026-08-06','replay_complete','2026-09-27T00:00:00Z')
      rows.slice(0,hotCount).forEach(f.hot)
      for(let offset=hotCount;offset<rows.length;offset+=2)await f.add('a'+offset,rows.slice(offset,offset+2))
      const history=createS12CalibrationHistory(f.env,f.adapter,START,END,NOW)
      const censor=await inspectS12TwCalibrationLifecycleCensoring(f.adapter,END,'weekly',NOW,history)
      const evidence=await loadS12TwCalibrationEvidence(f.adapter,START,END,history)
      const actual={censor,evidence}
      if(expected)assert.deepEqual(actual,expected);else expected=actual
      assert.equal(evidence.length,4);assert.equal(censor.completeRows,3);assert.equal(censor.completeDates,2)
      assert.equal(censor.pendingMaturityTerminalDates,1);assert.equal(censor.missingOrOtherRows,1)
      assert.equal(f.reads,Math.ceil((8-hotCount)/2))
      assert.ok(f.sentSizes.every(bytes=>bytes<=48*1024))
    }finally{f.db.close()}
  }
})

test('current id or either natural-key revision suppresses archived version without release proof',async()=>{
  for(const kind of ['id','trade','signal']) {
    const f=fixture()
    try {
      const old=row(),next={...old,pnl_pct:.09}
      if(kind!=='id')next.id=99
      if(kind==='trade')next.signal_date='2026-08-02'
      if(kind==='signal')next.trade_date='2026-08-11'
      f.hot(next);await f.add('a',[old],false)
      assert.deepEqual(await read(f),[])
    }finally{f.db.close()}
  }
})

test('bad checksum, missing release, conflicting versions, payload identity, or oversized read fail visibly',async()=>{
  for(const problem of ['checksum','release','conflicting','identity','budget']) {
    const f=fixture()
    try {
      await f.add('a',[row()],problem!=='release')
      if(problem==='checksum')f.objects.set('a',f.objects.get('a')!.replace('reaction_ready','reaction_wacky'))
      if(problem==='conflicting')await f.add('b',[row(2,{symbol:'2301',setup_id:'setup1',pnl_pct:.1})])
      if(problem==='identity') {
        const body=JSON.parse(f.objects.get('a')!);body.payload.rows[0].id=2
        const raw=JSON.stringify(body);f.objects.set('a',raw);f.db.prepare('UPDATE run_artifacts SET checksum=?').run(await sha256Text(raw))
      }
      if(problem==='budget')f.db.prepare('UPDATE run_artifacts SET row_count=?').run(REPLAY_READ_BUDGET.rows+1)
      await assert.rejects(read(f),new RegExp(problem))
      if(problem==='budget')assert.equal(f.reads,0)
    }finally{f.db.close()}
  }
})

test('manifest pagination, duplicates, null unique keys and fixed manifest timestamp',async()=>{
  const f=fixture()
  try {
    const original=row(1,{setup_id:null});f.hot({...original,id:2})
    for(let i=0;i<101;i++)await f.add(String(i).padStart(3,'0'),[original])
    await f.add('future',[row(3)],true,'2026-09-27')
    assert.deepEqual(await read(f),[original]);assert.equal(f.reads,101)
  }finally{f.db.close()}
})

test('huge unrelated JSON stays out of D1 projection; original SQL date and lifecycle semantics run in SQLite',async()=>{
  const f=fixture()
  try {
    const r=row();r.detail_json=JSON.stringify({...JSON.parse(r.detail_json),large_trace:'x'.repeat(500000)})
    f.life();await f.add('a',[r])
    const history=createS12CalibrationHistory(f.env,f.adapter,START,END,NOW)
    assert.equal((await loadS12TwCalibrationEvidence(f.adapter,START,END,history)).length,1)
    assert.ok(Math.max(...f.sentSizes)<2048)
  }finally{f.db.close()}
})

test('hot deletion between shared reads is rejected instead of silently changing calibration population',async()=>{
  const f=fixture()
  try {
    f.life();f.hot(row());const history=createS12CalibrationHistory(f.env,f.adapter,START,END,NOW)
    await inspectS12TwCalibrationLifecycleCensoring(f.adapter,END,'weekly',NOW,history)
    f.db.exec('DELETE FROM s12_replay_trade_outcomes')
    await assert.rejects(loadS12TwCalibrationEvidence(f.adapter,START,END,history),/hot_snapshot_changed/)
  }finally{f.db.close()}
})

test('wrong history window cannot inject outside-period samples',async()=>{
  const f=fixture()
  try {
    const history=createS12CalibrationHistory(f.env,f.adapter,START,END,NOW)
    await assert.rejects(loadS12TwCalibrationEvidence(f.adapter,'2026-08-01',END,history),/window_mismatch/)
  }finally{f.db.close()}
})


test('legacy Ops release fallback still requires a completed matching checksum and exact deleted count',async()=>{
  for(const problem of ['none','failed','count','checksum','empty_completed_at']) {
    const f=fixture()
    try {
      const original=row();await f.add('a',[original],false)
      const checksum=f.db.prepare("SELECT checksum FROM run_artifacts WHERE artifact_id='a'").get()!.checksum
      f.db.prepare('INSERT INTO data_retention_run_items VALUES(?,?,?,?)').run(problem==='failed'?'failed':'success',
        problem==='count'?2:1,JSON.stringify({artifact_id:'a',checksum:problem==='checksum'?'wrong':checksum}),
        problem==='empty_completed_at'?'':'2026-09-25T12:00:00Z')
      if(problem==='none')assert.deepEqual(await read(f),[original])
      else await assert.rejects(read(f),/release_receipt_incomplete/)
    }finally{f.db.close()}
  }
})
