import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { replayReleaseFixture } from './retentionS12ReplayTestFixture'
import { S12_REPLAY_ENGINE_SIGNATURE as ENGINE } from './s12ReplayContract'
import { withPaperExecutionScope, advancePaperExecutionClock } from './paperExecutionScope'
import { captureS12CalibrationWork as capture, appendS12CalibrationPage as page, finishS12CalibrationWork as finish,
  loadFrozenCalibrationEvidence as evidence, readCalibrationWorkCensoring as censor, type CalibrationWork } from './s12CalibrationWork'
import { ensureS12TwCalibrationTables, runS12TwCalibration, loadS12TwCalibrationEvidence,
  inspectS12TwCalibrationLifecycleCensoring } from './s12TwEquityCalibration'

const NOW=Date.parse('2026-09-26T02:00:00Z'), START='2026-03-30', END='2026-09-26'
const input={runDate:END,cadence:'monthly' as const,sourceVersion:'local-equivalence-test',snapshotAt:new Date(NOW).toISOString()}
const scratch=['s12_calibration_work_rows_v1','s12_calibration_work_lifecycle_v1','s12_calibration_work_censor_v1','s12_calibration_work_current_v1']
function row(id:number, patch:Record<string,any>={}) {
  return {id,symbol:String(2300+id),market:'LISTED',signal_date:'2026-06-01',trade_date:'2026-06-'+String(2+id%12).padStart(2,'0'),
    setup_id:'setup'+id,assessment_state:'reaction_ready',entry_ms:Date.parse('2026-06-10T01:30:00Z'),
    entry_price:100,stop_price:98,pnl_pct:(id%7-2)*.012,max_favorable_pct:.04,max_adverse_pct:-.01,sample_eligible:1,
    source:'s12_multisession_structure_replay_v3',detail_json:JSON.stringify({
      assessment_detail:'atr15m=2;equity_mutation_score=5;vwap_fast_reasons=reclaim|volume;vwap_fast_blockers=;session_60m_move_atr=0.8;session_60m_close_position=0.75',
      market_segment:'LISTED',alpha_bucket:'high',replay_diagnostics:{replay_engine_signature:ENGINE,replay_cohort_signature:'cohort1',outcome_known_date:'2026-06-20'}}),...patch}
}
async function fixture(count=96) {
  const f=replayReleaseFixture()
  f.sql.exec(readFileSync('domain-migrations/learning/0058_s12_calibration_work.sql','utf8'))
  for(let id=1;id<=count;id++)f.insert(row(id))
  f.sql.exec("INSERT INTO allocator_ev_daily_lifecycle VALUES('2026-06-01','replay_complete','2026-09-25','owner')")
  await ensureS12TwCalibrationTables(f.db)
  return f
}
async function scoped<T>(f:Awaited<ReturnType<typeof fixture>>,run:()=>Promise<T>):Promise<T> {
  return (await withPaperExecutionScope({environment:f.env,accountId:1,nowMs:NOW,databases:{learning:f.db,ops:f.db},
    fetchFrozen:async()=>{throw new Error('network forbidden')}},run)).result
}
async function archive(f:Awaited<ReturnType<typeof fixture>>,count:number,size=8) {
  const rows=f.rows().slice(0,count)
  for(let i=0;i<rows.length;i+=size)await (await f.seal('raw'+i,rows.slice(i,i+size))).release()
}
async function complete(f:Awaited<ReturnType<typeof fixture>>,w:CalibrationWork) {
  while(w.phase==='reading')w=await page(f.env,f.db,w,{maxManifests:1})
  return w
}

test('frozen hot/lifecycle + bounded cold pages exactly preserve evidence, censoring and numeric artifacts',async()=>{
  for(const coldCount of [0,48,96]) {
    const f=await fixture()
    try {await scoped(f,async()=>{
      const expectedEvidence=await loadS12TwCalibrationEvidence(f.db,START,END)
      const expectedCensor=await inspectS12TwCalibrationLifecycleCensoring(f.db,END,'monthly',NOW)
      const expected=await runS12TwCalibration(f.db,{runDate:END,cadence:'monthly',dryRun:true})
      assert.ok(expected.artifacts.length>0,'exercise actual numeric algorithm')
      await archive(f,coldCount)
      let w=await capture(f.db,input)
      f.sql.exec("UPDATE s12_replay_trade_outcomes SET pnl_pct=.99; UPDATE allocator_ev_daily_lifecycle SET state='replay_enqueued'")
      w=await complete(f,w)
      assert.deepEqual(await evidence(f.db,w),expectedEvidence)
      assert.deepEqual(await censor(f.db,w.run_id),expectedCensor)
      const result=await finish(f.db,w)
      assert.equal(result.deferred,false)
      if(result.deferred)throw new Error('unexpected defer')
      assert.deepEqual(result.result.artifacts,expected.artifacts)
      for(const table of scratch)assert.equal(f.count(table),0,table)
      assert.equal(f.count('s12_tw_calibration_runs'),1)
      assert.equal(f.count('s12_tw_calibration_artifacts'),expected.artifacts.length)
      assert.equal(f.downloads.length,coldCount/8)
    })}finally{f.sql.close()}
  }
})

test('capture and page failures roll back all state; lease loss cannot commit cursor or evidence',async()=>{
  const f=await fixture(16)
  try {await scoped(f,async()=>{
    await archive(f,8)
    f.failAt('INSERT INTO s12_calibration_work_censor_v1')
    await assert.rejects(capture(f.db,input),/injected/)
    for(const table of ['s12_calibration_work_v1',...scratch])assert.equal(f.count(table),0,table)
    f.failAt('');const w=await capture(f.db,input)
    const original=await censor(f.db,w.run_id)
    f.failAt('INSERT INTO s12_calibration_work_censor_v1')
    await assert.rejects(page(f.env,f.db,w),/injected/)
    assert.deepEqual(await capture(f.db,input),w)
    assert.equal(f.count(scratch[0]),8)
    assert.deepEqual(await censor(f.db,w.run_id),original)
    f.failAt('')
    await assert.rejects(page(f.env,f.db,w,{beforeCommit:async()=>{throw new Error('lease lost')}}),/lease lost/)
    assert.deepEqual(await capture(f.db,input),w)
    const ready=await page(f.env,f.db,w)
    assert.equal(ready.retained_rows,16);assert.equal(ready.revision,1)
  })}finally{f.sql.close()}
})

test('lost page acknowledgement and stale delivery do not double count; restart skips completed files',async()=>{
  const f=await fixture(24)
  try {await scoped(f,async()=>{
    await archive(f,24)
    const w=await capture(f.db,input),originalBatch=f.db.batch.bind(f.db)
    let lose=true
    const uncertain={prepare:f.db.prepare,batch:async(s:D1PreparedStatement[])=>{
      const result=await originalBatch(s);if(lose){lose=false;throw new Error('lost ack')}return result
    }} as D1Database
    await assert.rejects(page(f.env,uncertain,w,{maxManifests:1}),/lost ack/)
    const saved=await capture(f.db,input)
    assert.equal(saved.revision,1);assert.equal(saved.retained_rows,8)
    await page(f.env,f.db,w,{maxManifests:1})
    assert.equal((await capture(f.db,input)).revision,1)
    assert.equal((await censor(f.db,w.run_id)).completeRows,8)
    f.downloads.length=0
    const ready=await complete(f,saved)
    assert.equal(ready.retained_rows,24)
    assert.equal((await censor(f.db,w.run_id)).completeRows,24)
    assert.deepEqual(f.downloads,['raw8:compact','raw16:compact'])
    await assert.rejects(capture(f.db,{...input,sourceVersion:'different-source'}),/source_version_changed/)
  })}finally{f.sql.close()}
})

test('post-capture archive of frozen hot rows is excluded by cold inventory watermark',async()=>{
  const f=await fixture(24)
  try {await scoped(f,async()=>{
    const expected=await loadS12TwCalibrationEvidence(f.db,START,END)
    await archive(f,8)
    const w=await capture(f.db,input)
    await (await f.seal('late',f.rows())).release()
    const ready=await complete(f,w)
    assert.deepEqual(await evidence(f.db,ready),expected)
    assert.deepEqual(f.downloads,['raw0:compact'])
    assert.equal((await censor(f.db,w.run_id)).completeRows,24)
  })}finally{f.sql.close()}
})

test('corrupt cold file and incomplete work cannot publish a partial population',async()=>{
  const f=await fixture(16)
  try {await scoped(f,async()=>{
    await archive(f,16)
    const w=await capture(f.db,input)
    await assert.rejects(finish(f.db,w),/input_incomplete/)
    f.objects.set('raw0:compact',f.objects.get('raw0:compact')!.replace('reaction_ready','corrupted_state'))
    await assert.rejects(page(f.env,f.db,w))
    assert.deepEqual(await capture(f.db,input),w)
    assert.equal(f.count('s12_tw_calibration_runs'),0)
  })}finally{f.sql.close()}
})

test('publication and cleanup are atomic; failed publication preserves all frozen input for retry',async()=>{
  const f=await fixture()
  try {await scoped(f,async()=>{
    const w=await complete(f,await capture(f.db,input))
    f.failAt('DELETE FROM s12_calibration_work_rows_v1')
    await assert.rejects(finish(f.db,w),/injected/)
    assert.deepEqual(await capture(f.db,input),w)
    assert.equal(f.count('s12_tw_calibration_runs'),0)
    assert.equal(f.count('s12_tw_calibration_artifacts'),0)
    assert.equal(f.count(scratch[0]),96)
    f.failAt('')
    const original=f.db.batch.bind(f.db)
    const uncertain={prepare:f.db.prepare,batch:async(s:D1PreparedStatement[])=>{await original(s);throw new Error('lost final ack')}} as unknown as D1Database
    await assert.rejects(finish(uncertain,w),/lost final ack/)
    assert.equal(f.count('s12_tw_calibration_runs'),1)
    assert.equal(f.sql.prepare('SELECT phase FROM s12_calibration_work_v1').get()?.phase,'committed')
    for(const table of scratch)assert.equal(f.count(table),0,table)
    await assert.rejects(finish(f.db,w),/scratch_incomplete/)
  })}finally{f.sql.close()}
})

test('recent lifecycle defers, clears only scratch, and captures a fresh generation after maturity',async()=>{
  const f=await fixture()
  try {await scoped(f,async()=>{
    f.sql.exec("UPDATE allocator_ev_daily_lifecycle SET state='replay_enqueued',updated_at='2026-09-26T01:00:00Z'")
    const w=await complete(f,await capture(f.db,input))
    const deferred=await finish(f.db,w)
    assert.deepEqual(deferred,{deferred:true,dates:['2026-06-01']})
    assert.equal(f.count('s12_tw_calibration_runs'),0)
    for(const table of scratch)assert.equal(f.count(table),0,table)
    f.sql.exec("UPDATE allocator_ev_daily_lifecycle SET state='replay_complete'")
    const fresh=await complete(f,await capture(f.db,input))
    assert.notEqual(fresh.run_id,w.run_id)
    assert.equal(fresh.retained_rows,96)
    await finish(f.db,fresh)
    assert.equal(f.count('s12_tw_calibration_runs'),1)
    assert.equal(f.count('s12_calibration_work_v1'),2,'attempt receipts retained')
  })}finally{f.sql.close()}
})

test('all lifecycle censor categories and invalid evidence rows retain the original semantics',async()=>{
  const f=await fixture(0)
  try {await scoped(f,async()=>{
    const lives=[['2026-06-02','replay_pending_maturity','2026-09-25'],['2026-06-03','replay_enqueued','2026-09-26T01:00:00Z'],
      ['2026-06-04','replay_enqueued','2026-09-24'],['2026-06-05','replay_enqueued','invalid'],
      ['2026-06-06','replay_complete','2026-09-27'],['2026-06-07','failed','2026-09-25']]
    for(const l of lives)f.sql.prepare("INSERT INTO allocator_ev_daily_lifecycle VALUES(?,?,?,'owner')").run(...l)
    for(let id=1;id<=18;id++)f.insert(row(id,{signal_date:'2026-06-0'+(1+id%8),...(id===9?{stop_price:101}:{})}))
    const expected=await loadS12TwCalibrationEvidence(f.db,START,END)
    const expectedCensor=await inspectS12TwCalibrationLifecycleCensoring(f.db,END,'monthly',NOW)
    await archive(f,9,3)
    const w=await complete(f,await capture(f.db,input))
    assert.deepEqual(await evidence(f.db,w),expected)
    assert.deepEqual(await censor(f.db,w.run_id),expectedCensor)
  })}finally{f.sql.close()}
})
test('100005 source rows preserve the lowest 100000 IDs across cold arrival, including invalid rows',async()=>{
  const f=await fixture(0)
  try {await scoped(f,async()=>{
    const template=row(1,{assessment_state:'invalid'})
    f.insert(template)
    f.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT 2 UNION ALL SELECT id+1 FROM ids WHERE id<100005)
      INSERT INTO s12_replay_trade_outcomes(id,symbol,market,signal_date,trade_date,setup_id,assessment_state,entry_ms,
        entry_price,stop_price,pnl_pct,max_favorable_pct,max_adverse_pct,sample_eligible,source,detail_json)
      SELECT ids.id,CAST(ids.id AS TEXT),o.market,o.signal_date,o.trade_date,'setup'||ids.id,'reaction_ready',o.entry_ms,
        o.entry_price,o.stop_price,o.pnl_pct,o.max_favorable_pct,o.max_adverse_pct,o.sample_eligible,o.source,o.detail_json
      FROM ids JOIN s12_replay_trade_outcomes o ON o.id=1`)
    await archive(f,5,5)
    const w=await capture(f.db,input)
    assert.equal(w.retained_rows,100000)
    const ready=await complete(f,w)
    const bounds=f.sql.prepare('SELECT MIN(id) low,MAX(id) high,COUNT(*) n FROM s12_calibration_work_rows_v1').get()
    assert.deepEqual({...bounds},{low:1,high:100000,n:100000})
    const before=f.calls,rows=await evidence(f.db,ready)
    assert.equal(rows.length,99999,'invalid row consumes its ID slot before decoding')
    assert.ok(f.calls-before<=197,'bounded 512-row pages reduce final database round trips')
    assert.equal((await censor(f.db,w.run_id)).completeRows,100005,'censor all source rows, not only selected IDs')
  })}finally{f.sql.close()}
})

test('frozen binary64 values round-trip without changing the numerical decoder',async()=>{
  const f=await fixture(0)
  try {await scoped(f,async()=>{
    const values=[.036,.000000000000001,Math.PI,1/3,1.0000000000000002,12345.678912345678,Number.MIN_VALUE,-1e-200]
    for(let id=1;id<=values.length;id++)f.insert(row(id,{pnl_pct:values[id-1],entry_price:123.45678901234567,
      stop_price:121.1111111111111,max_favorable_pct:values[id-1],max_adverse_pct:-values[id-1]}))
    const expected=await loadS12TwCalibrationEvidence(f.db,START,END)
    const ready=await complete(f,await capture(f.db,input))
    assert.deepEqual(await evidence(f.db,ready),expected)
  })}finally{f.sql.close()}
})

test('scratch limits reject atomically instead of truncating evidence or growing without bounds',async()=>{
  const f=await fixture(1)
  try {await scoped(f,async()=>{
    f.sql.prepare("UPDATE s12_replay_trade_outcomes SET detail_json=json_set(detail_json,'$.assessment_detail',?)").run('atr15m='+'x'.repeat(33000))
    await assert.rejects(capture(f.db,input),/CHECK constraint/)
    for(const table of ['s12_calibration_work_v1',...scratch])assert.equal(f.count(table),0)
    f.sql.prepare('UPDATE s12_replay_trade_outcomes SET detail_json=?').run(row(1).detail_json)
    await capture(f.db,input)
    await capture(f.db,{...input,runDate:'2026-09-25'})
    await assert.rejects(capture(f.db,{...input,runDate:'2026-09-24'}),/CHECK constraint/)
    assert.equal(f.count('s12_calibration_work_v1'),2)
    assert.equal(f.count('s12_calibration_work_current_v1'),2)
  })}finally{f.sql.close()}
})
test('idle scratch expires atomically, preserves receipt, rejects stale writers and allows a new generation',async()=>{
  const f=await fixture(8)
  try {await scoped(f,async()=>{
    const old=await capture(f.db,input)
    advancePaperExecutionClock(NOW+24*60*60_000+1)
    f.failAt('DELETE FROM s12_calibration_work_lifecycle_v1')
    await assert.rejects(capture(f.db,input),/injected/)
    assert.equal(f.sql.prepare('SELECT phase FROM s12_calibration_work_v1').get()?.phase,'reading')
    assert.equal(f.count(scratch[0]),8)
    f.failAt('')
    const fresh=await capture(f.db,input)
    assert.notEqual(fresh.run_id,old.run_id)
    assert.equal(f.count('s12_calibration_work_v1'),2)
    assert.equal(f.count(scratch[0]),8)
    const stale=await page(f.env,f.db,old)
    assert.equal(stale.phase,'expired')
    await assert.rejects(finish(f.db,stale),/input_incomplete/)
    assert.equal((await capture(f.db,input)).run_id,fresh.run_id)
    await finish(f.db,await complete(f,fresh))
    for(const table of scratch)assert.equal(f.count(table),0)
  })}finally{f.sql.close()}
})

test('immutable capture rejects replacement and migration is idempotent with identical owner-schema definitions',async()=>{
  const f=await fixture(1)
  try {await scoped(f,async()=>{
    await capture(f.db,input)
    for(const table of ['s12_calibration_work_v1',scratch[0],scratch[1]])
      assert.throws(()=>f.sql.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),/frozen/)
    assert.throws(()=>f.sql.exec("UPDATE s12_calibration_work_rows_v1 SET row_json='{}'"),/frozen/)
    f.sql.exec(readFileSync('domain-migrations/learning/0058_s12_calibration_work.sql','utf8'))
    const {DatabaseSync}=await import('node:sqlite'),owner=new DatabaseSync(':memory:')
    try {
      owner.exec(readFileSync('domain-schemas/learning.sql','utf8'))
      const query="SELECT name,sql FROM sqlite_master WHERE name LIKE '%s12_calibration_work%' ORDER BY name"
      assert.deepEqual(f.sql.prepare(query).all(),owner.prepare(query).all())
    }finally{owner.close()}
  })}finally{f.sql.close()}
})
test('Cloudflare local D1 runtime preserves capture transactions, frozen REAL precision and final atomic receipt',async()=>{
  const {Miniflare}=await import('miniflare')
  const mf=new Miniflare({modules:true,script:'export default { fetch(){ return new Response("ok") } }',d1Databases:['LEARNING']})
  const f=await fixture(96)
  try {
    const db=await mf.getD1Database('LEARNING') as unknown as D1Database
    const ddls=f.sql.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all()
    await db.batch(ddls.map(d=>db.prepare(String(d.sql))))
    const rows=f.rows().map(({__cursor_key,__archive_date,...r})=>r)
    await db.batch(rows.map(r=>db.prepare(`INSERT INTO s12_replay_trade_outcomes(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(()=>'?').join(',')})`).bind(...Object.values(r))))
    await db.prepare("INSERT INTO allocator_ev_daily_lifecycle VALUES('2026-06-01','replay_complete','2026-09-25','owner')").run()
    await withPaperExecutionScope({environment:{...f.env,DB:db},accountId:1,nowMs:NOW,databases:{learning:db,ops:db},
      fetchFrozen:async()=>{throw new Error('network forbidden')}},async()=>{
      const expected=await loadS12TwCalibrationEvidence(db,START,END)
      const w=await capture(db,input)
      await db.prepare('UPDATE s12_replay_trade_outcomes SET pnl_pct=.99').run()
      const ready=await page(f.env,db,w)
      assert.deepEqual(await evidence(db,ready),expected)
      await finish(db,ready)
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM s12_tw_calibration_runs').first<any>())?.n,1)
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM s12_calibration_work_rows_v1').first<any>())?.n,0)
    })
  }finally{f.sql.close();await mf.dispose()}
})
test('compact assessment keeps empty, duplicate, case, escaped and Unicode token semantics while dropping unused prose',async()=>{
  const f=await fixture(0)
  try {await scoped(f,async()=>{
    const details=[
      'atr15m=;atr15m=9;equity_mutation_score=5;vwap_fast_reasons=a|b;ignored='+('long prose;'.repeat(500)),
      'atr15m=2;atr15m=3;equity_mutation_score= 6 ;vwap_fast_reasons=台灣|"quoted"|\\;vwap_fast_blockers=;session_60m_move_atr=\n0.5;session_60m_close_position=.75',
      'ATR15M=3; atr15m=4;atr15m=2;equity_mutation_score=0',
      'explanation=x=atr15m=55;atr15m=1;session_60m_move_atr=',
      '',
    ]
    for(let id=1;id<=details.length;id++) {
      const r=row(id),detail=JSON.parse(r.detail_json);detail.assessment_detail=details[id-1];r.detail_json=JSON.stringify(detail);f.insert(r)
    }
    const expected=await loadS12TwCalibrationEvidence(f.db,START,END)
    const ready=await complete(f,await capture(f.db,input))
    assert.deepEqual(await evidence(f.db,ready),expected)
    const projected=f.sql.prepare('SELECT row_json FROM s12_calibration_work_rows_v1 WHERE id=1').get()?.row_json as string
    assert.ok(projected.length<1000)
    assert.ok(!projected.includes('long prose'))
  })}finally{f.sql.close()}
})
test('real durable scheduler resumes stored pages and recovers lost final acknowledgement through canonical receipt',async()=>{
  const {processDurableSchedulerTask}=await import('./durableSchedulerTask')
  const f=await fixture(96),sent:any[]=[],kv=new Map<string,string>()
  try {
    f.sql.exec(`CREATE TABLE maintenance_task_leases(lease_group TEXT PRIMARY KEY,task_name TEXT,owner_id TEXT,lease_expires_at TEXT,acquired_at TEXT,heartbeat_at TEXT);
      CREATE TABLE scheduler_locks(lock_key TEXT PRIMARY KEY,owner TEXT,run_date TEXT,run_id TEXT,created_at TEXT,expires_at TEXT);
      UPDATE s12_replay_trade_outcomes SET trade_date=replace(trade_date,'2026-06','2026-07');`)
    Object.assign(f.env,{CF_VERSION_METADATA:{tag:'local-equivalence-test'},
      KV:{async get(key:string,type?:string){const value=kv.get(key);return value==null?null:type==='json'?JSON.parse(value):value},
        async put(key:string,value:string){kv.set(key,value)}},
      UPDATE_QUEUE:{async send(message:any){sent.push(message)}}})
    await scoped(f,async()=>{
      await archive(f,40,8)
      const message={type:'scheduled_admin_task' as const,cursor:0,triggerTime:END,runId:'actual-scheduler-test',scheduledTask:'s12-smcvwap-calibration' as const}
      await processDurableSchedulerTask(message,f.env)
      assert.equal(sent.length,1)
      assert.equal(f.downloads.length,4)
      assert.equal(f.count('s12_tw_calibration_runs'),0)
      assert.equal(kv.has('scheduler:terminal:s12-smcvwap-calibration:'+END),false)
      const batch=f.db.batch.bind(f.db);let lose=true
      f.db.batch=async(s:any[])=>{const result=await batch(s)
        if(lose&&s.some(v=>v.query.includes('INSERT OR REPLACE INTO s12_tw_calibration_runs'))){lose=false;throw new Error('lost canonical ack')}
        return result}
      await assert.rejects(processDurableSchedulerTask(sent[0],f.env),/lost canonical ack/)
      assert.equal(f.count('s12_tw_calibration_runs'),1)
      assert.equal(f.downloads.length,5)
      for(const table of scratch)assert.equal(f.count(table),0)
      await processDurableSchedulerTask(sent[0],f.env)
      const terminal=JSON.parse(kv.get('scheduler:terminal:s12-smcvwap-calibration:'+END)!)
      assert.equal(terminal.status,'success')
      assert.equal(terminal.materialization_receipt.idempotent,true)
      assert.equal(terminal.materialization_receipt.artifact_count_parity,true)
      assert.equal(f.downloads.length,5,'canonical retry downloads no completed cold page')
      assert.equal(sent.length,1)
      assert.equal(f.count('maintenance_task_leases'),0)
      assert.equal(f.count('scheduler_locks'),0)
    })
  }finally{f.sql.close()}
})
test('malformed numeric source remains excluded or null rather than becoming a coerced zero',async()=>{
  const f=await fixture(0)
  try {await scoped(f,async()=>{
    for(const [index,patch] of [{pnl_pct:'NaN'},{pnl_pct:'Infinity'},{entry_price:'invalid'},
      {stop_price:'missing'},{max_favorable_pct:'unknown'}, {max_adverse_pct:'bad'}].entries())f.insert(row(index+1,patch))
    const expected=await loadS12TwCalibrationEvidence(f.db,START,END)
    const ready=await complete(f,await capture(f.db,input))
    assert.deepEqual(await evidence(f.db,ready),expected)
    assert.equal(expected.length,2)
  })}finally{f.sql.close()}
})