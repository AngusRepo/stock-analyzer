import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { capturePostVerifyMetricEvidence, verifyPostVerifyMetricEvidence } from './postVerifyMetricEvidence'
import { publishMetricSnapshot } from './strategyMetricSnapshots'
import { STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION, strategyMetricPublicationScope } from './strategyEvidenceMetrics'
import { evaluateStrategyEvidenceOwnerCalibration, STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION } from './strategyEvidenceOwnerCalibration'

const businessDate='2026-10-16', canonicalRunId='canonical-fixture'
function database() {
  const sql=new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-migrations/learning/0042_strategy_metric_run_snapshots.sql','utf8'))
  sql.exec(readFileSync('domain-migrations/learning/0026_strategy_evidence_owner_calibration.sql','utf8'))
  const db={prepare(query:string){let values:any[]=[];const statement={
    bind(...args:any[]){values=args;return statement},
    async first(){return sql.prepare(query).get(...values)??null},
    async all(){return {results:sql.prepare(query).all(...values)}},
    async run(){return sql.prepare(query).run(...values)},
  };return statement},async batch(statements:any[]){
    sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out}
    catch(error){sql.exec('ROLLBACK');throw error}
  }} as any
  return {sql,db}
}
async function fixture(split=false, empty=false) {
  const owner=database(),target=split?database():owner
  const env={DB:owner.db,...(split?{LEARNING_DB:target.db}:{})} as any
  const metric=async(date:string,canonical=false)=>publishMetricSnapshot(target.db,{
    date,definition:STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION,mode:'authority_bridge',
    scope:strategyMetricPublicationScope(canonical?`canonical:${canonicalRunId}`:`daily:${date}`),
    source:'local-fixture',profiles:empty?0:1,observations:empty?0:30,readyRows:empty?0:1,
    rows:empty?[]:[{strategy_id:'s',strategy_version:'v1',strategy_status:'active',alpha_bucket:'fixture',
      primary_horizon_days:5,metric_name:'rank_ic',metric_value:.3,metric_status:'ready',sample_count:30,
      mature_dates:5,date_start:'2026-09-01',date_end:date,outcome_as_of_date:date,
      definition_version:STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION,evidence_json:'{}'} as any],
  })
  const result=await evaluateStrategyEvidenceOwnerCalibration({
    profiles:empty?[]:[{strategy_id:'s',strategy_version:'v1',strategy_status:'active',primary_horizon_days:5,required_metrics:['rank_ic']}],
    metricRows:[],dateReturns:[],allowPromotion:false,
  })
  const runId='calibration-fixture'
  owner.sql.prepare(`INSERT INTO strategy_evidence_owner_calibration_runs_v1
    (run_id,artifact_version,knowledge_cutoff_date,status,source_metric_definition_version,
      source_snapshot_count,source_snapshot_checksum,sample_count,date_count,gate_json,artifact_checksum)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(runId,STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION,businessDate,result.status,
      STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION,result.sourceSnapshotCount,result.sourceSnapshotChecksum,
      result.sampleCount,result.dateCount,JSON.stringify({...result.gates,history_checksum:result.historyChecksum}),result.artifactChecksum)
  for(const a of result.artifacts) owner.sql.prepare(`INSERT INTO strategy_evidence_owner_calibration_artifacts_v1
    (artifact_id,run_id,strategy_id,strategy_version,metric_outcome_as_of_date,multi_horizon_score,
      weight_multiplier,source_metric_checksum,payload_checksum) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(`${runId}:${a.strategy_id}`,runId,a.strategy_id,a.strategy_version,a.metric_outcome_as_of_date,
      a.multi_horizon_score,a.weight_multiplier,a.source_metric_checksum,a.payload_checksum)
  const calibration={runId,result}
  const metrics=await metric(businessDate,true)
  const capture=()=>capturePostVerifyMetricEvidence(env,{task:'strategy-evidence-current',businessDate,canonicalRunId,metrics,calibration})
  const close=()=>{owner.sql.close();if(split)target.sql.close()}
  return {owner,target,env,metric,metrics,calibration,capture,close}
}

test('current evidence freshly verifies exact snapshot and pending-maturity calibration without promotion',async()=>{
  const f=await fixture(),evidence=await f.capture()
  assert.equal(evidence.calibration?.status,'pending_maturity')
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),true)
  assert.equal(f.owner.sql.prepare('SELECT COUNT(*) n FROM strategy_evidence_owner_calibration_head_v1').get()!.n,0)
  f.close()
})
test('metric shadow publisher and calibration authority remain separate read owners',async()=>{
  const f=await fixture(true),evidence=await f.capture()
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),true)
  assert.equal(f.owner.sql.prepare('SELECT COUNT(*) n FROM strategy_evidence_metric_snapshot_runs_v2').get()!.n,0)
  assert.equal(f.target.sql.prepare('SELECT COUNT(*) n FROM strategy_evidence_owner_calibration_runs_v1').get()!.n,0)
  f.close()
})
for(const fault of ['metric-delete','metric-change','calibration-delete','calibration-change','calibration-gate','calibration-status']) {
  test(`fresh readback rejects ${fault} after successful capture`,async()=>{
    const f=await fixture(),evidence=await f.capture()
    if(fault==='metric-delete')f.target.sql.exec('DELETE FROM strategy_evidence_metric_snapshot_rows_v2')
    if(fault==='metric-change')f.target.sql.exec("UPDATE strategy_evidence_metric_snapshot_rows_v2 SET row_json=json_set(row_json,'$.metric_value',99)")
    if(fault==='calibration-delete')f.owner.sql.exec('DELETE FROM strategy_evidence_owner_calibration_artifacts_v1')
    if(fault==='calibration-change')f.owner.sql.exec('UPDATE strategy_evidence_owner_calibration_artifacts_v1 SET weight_multiplier=9')
    if(fault==='calibration-gate')f.owner.sql.exec("UPDATE strategy_evidence_owner_calibration_runs_v1 SET gate_json=json_set(gate_json,'$.history_checksum','changed')")
    if(fault==='calibration-status')f.owner.sql.exec("UPDATE strategy_evidence_owner_calibration_runs_v1 SET status='approved'")
    assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),false)
    f.close()
  })
}
test('capture rejects claimed producer results that disagree with actual readback',async()=>{
  const f=await fixture()
  await assert.rejects(capturePostVerifyMetricEvidence(f.env,{task:'strategy-evidence-current',businessDate,canonicalRunId,
    metrics:{...f.metrics,payload_checksum:'f'.repeat(64)},calibration:f.calibration}),/producer_readback_mismatch/)
  await assert.rejects(capturePostVerifyMetricEvidence(f.env,{task:'strategy-evidence-current',businessDate,canonicalRunId,
    metrics:f.metrics,calibration:{...f.calibration,result:{...f.calibration.result,status:'promoted'}}}),/producer_readback_mismatch/)
  f.close()
})
test('backfill binds every original processed date and aggregate row counts',async()=>{
  const f=await fixture()
  await f.metric('2026-10-14');await f.metric('2026-10-15')
  const metrics={processedDates:['2026-10-14','2026-10-15'],materializedRows:2,readyRows:2,summary:'local'}
  const evidence=await capturePostVerifyMetricEvidence(f.env,{task:'strategy-evidence-metric-backfill',businessDate,canonicalRunId,metrics})
  assert.equal(evidence.calibration,null)
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),true)
  f.target.sql.prepare('DELETE FROM strategy_evidence_metric_snapshot_rows_v2 WHERE snapshot_run_id=?').run(evidence.snapshots[1].snapshotRunId)
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),false)
  await assert.rejects(capturePostVerifyMetricEvidence(f.env,{task:'strategy-evidence-metric-backfill',businessDate,canonicalRunId,
    metrics:{...metrics,processedDates:['2026-10-14','2026-10-14']}}),/result_invalid/)
  f.close()
})
test('legitimate empty backfill remains empty evidence, not fabricated maturity',async()=>{
  const f=await fixture()
  const evidence=await capturePostVerifyMetricEvidence(f.env,{task:'strategy-evidence-metric-backfill',businessDate,canonicalRunId,
    metrics:{processedDates:[],materializedRows:0,readyRows:0,summary:'processed=0'}})
  assert.deepEqual(evidence.snapshots,[])
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),true)
  await assert.rejects(capturePostVerifyMetricEvidence(f.env,{task:'strategy-evidence-metric-backfill',businessDate,canonicalRunId,
    metrics:{processedDates:[],materializedRows:1,readyRows:0,summary:'forged'}}),/readback_mismatch/)
  f.close()
})
test('tampered scope/receipt fails closed, while missing schema blocks verification',async()=>{
  const f=await fixture(),evidence=await f.capture()
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,{...evidence,canonicalRunId:'other'}),false)
  assert.equal(await verifyPostVerifyMetricEvidence(f.env,{...evidence,snapshots:[]}),false)
  f.target.sql.exec('DROP TABLE strategy_evidence_metric_snapshot_rows_v2')
  await assert.rejects(verifyPostVerifyMetricEvidence(f.env,evidence),/no such table/)
  f.close()
})
test('metric read timeout propagates instead of becoming a confirmed missing optional artifact',async()=>{
  const f=await fixture(),evidence=await f.capture()
  f.env.DB={prepare(){return {bind(){return {async first(){throw new Error('fixture network read timeout')}}}}}} as any
  await assert.rejects(verifyPostVerifyMetricEvidence(f.env,evidence),/network read timeout/)
  f.close()
})

for (const table of ['strategy_evidence_metric_snapshot_rows_v2','strategy_evidence_owner_calibration_artifacts_v1']) {
  for (const [kind, result] of [['failed',{success:false,results:[]}],['missing',{success:true}],['invalid',{success:true,results:null}]] as const) {
    test(`empty valid output still blocks ${kind} read result from ${table}`,async()=>{
      const f=await fixture(false,true),evidence=await f.capture()
      assert.equal(f.metrics.metric_rows,0)
      assert.deepEqual(f.calibration.result.artifacts,[])
      assert.equal(await verifyPostVerifyMetricEvidence(f.env,evidence),true)
      const db=f.env.DB
      f.env.DB={...db,prepare(query:string){
        const statement=db.prepare(query)
        if (query.includes(`FROM ${table}`)) statement.all=async()=>result
        return statement
      }}
      await assert.rejects(verifyPostVerifyMetricEvidence(f.env,evidence),/read_failure|owner_read_failed/)
      f.close()
    })
  }
}
