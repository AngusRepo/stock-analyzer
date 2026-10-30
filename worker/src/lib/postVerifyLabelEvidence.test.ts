import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { capturePostVerifyLabelEvidence, verifyPostVerifyLabelEvidence } from './postVerifyLabelEvidence'
import { PRICE_HORIZON_PROJECTION_VERSION as v1, STRATEGY_MULTI_HORIZON_PROJECTION_VERSION as v2,
  PRICE_HORIZON_SOURCE as source } from './priceHorizonProjection'
import { SELECTION_REFERENCE_CONTRACT_VERSION as contract } from './selectionReferenceEvidence'
import { STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION as outcomeSchema } from './strategyMultiHorizonOutcomes'

const businessDate='2026-10-16', signal='2026-10-01', sha='a'.repeat(40)
// Rows proven row by row in a table (v2: one paged proof per key, plus GROUP BY count entries that are skipped).
const rowProof=(proof:{tables:Array<Record<string,any>>},table:string)=>{
  const proofs=proof.tables.filter(t=>t.table===table&&t.kind!=='group-count')
  return proofs.length?{rows:proofs.reduce((sum,t)=>sum+Number(t.rows),0)}:undefined
}
function fixture(size=3) {
  const sql=new DatabaseSync(':memory:')
  const extract=(file:string,table:string)=>{
    const text=readFileSync(file,'utf8'), match=text.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert.ok(match,table);sql.exec(match[0])
  }
  for(const name of ['price_horizon_labels_v1','price_horizon_label_rejections_v1'])extract('domain-migrations/learning/0001_learning_baseline.sql',name)
  for(const name of ['price_horizon_labels_v2','price_horizon_label_rejections_v2','canonical_selection_outcomes_v1'])extract('domain-migrations/learning/0011_strategy_multi_horizon_outcomes.sql',name)
  for(const name of ['price_horizon_projection_status','price_horizon_projection_runs'])extract('domain-migrations/ops/0001_ops_baseline.sql',name)
  extract('domain-migrations/ops/0007_strategy_multi_horizon_projection_status.sql','price_horizon_projection_status_v2')
  extract('domain-migrations/ops/0005_ops_artifact_compute_cost_runtime.sql','canonical_run_heads')
  sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql','utf8'))
  sql.exec(`CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,lease_expires_at TEXT);
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,stock_id INTEGER,
      market_segment TEXT,sector TEXT,feature_contract_version TEXT,hard_gate_passed INTEGER,
      PRIMARY KEY(signal_date,symbol,producer_run_id));`)
  sql.prepare('INSERT INTO pipeline_stage_runs VALUES(?,?,?,?,?)').run(businessDate,'post_verify_chain','finlab-A','running','2099-01-01')
  const root=(id:string,updated:string)=>sql.prepare(`INSERT INTO scheduler_execution_tickets_v1
    (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,updated_at)
    VALUES(?,?,?,'evening-chain','evening-chain',?,'physical-evening','attempt','physical_root','running','scheduler_http','checksum',?)`)
    .run(id,id,id,businessDate,updated)
  root('root-A','2026-10-16 00:00:00')
  const start=new Date(businessDate+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-120)
  sql.prepare(`INSERT INTO price_horizon_projection_runs(run_id,start_date,end_date,outcome_as_of_date,eligible_signal_dates,
    processed_signal_dates,candidate_count,materialized_count,rejected_count,status,completed_at)
    VALUES('projection-A',?,?,?,1,?,?,?,0,'success','2026-10-16 01:00:00')`)
    .run(start.toISOString().slice(0,10),businessDate,businessDate,size?1:0,size,size)
  sql.prepare('INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?,?,?)')
    .run(`screener:${signal}:TW:production:market_screener`,'screener-A','2026-10-01')
  for(let id=1;id<=size;id++) {
    sql.prepare(`INSERT INTO price_horizon_labels_v1(stock_id,price_date,entry_date,entry_raw_open,entry_adjustment_factor,
      exit_date,exit_raw_close,exit_adjustment_factor,outcome_known_date,source,projection_version) VALUES(?,?,?,10,1,?,11,1,?,?,?)`)
      .run(id,signal,'2026-10-02','2026-10-08','2026-10-08',source,v1)
    sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES(?,?,?,?,?,?,?,1)').run(signal,String(id),'screener-A',id,'listed','sector',contract)
    for(const horizon of [3,5,10]) {
      sql.prepare(`INSERT INTO price_horizon_labels_v2(stock_id,price_date,horizon_days,entry_date,entry_raw_open,entry_adjustment_factor,
        exit_date,exit_raw_close,exit_adjustment_factor,outcome_known_date,source,projection_version) VALUES(?,?,?,?,10,1,?,11,1,?,?,?)`)
        .run(id,signal,horizon,'2026-10-02','2026-10-08','2026-10-08',source,v2)
      sql.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,label_schema_version,
        market_segment,sector,entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,
        benchmark_return_net,benchmark_scope,residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
        VALUES(?,?,?,?,?,'listed','sector','2026-10-02','2026-10-08','2026-10-08',.1,18,.0982,.04,'market',.0582,.5,
          'price_horizon_labels_v2:finlab_primary_canonical_mirror',?)`).run(signal,String(id),'screener-A',horizon,outcomeSchema,contract)
    }
  }
  if(size) {
    sql.prepare(`INSERT INTO price_horizon_projection_status(signal_date,entry_date,exit_date,candidate_count,materialized_count,
      rejected_count,status,source,projection_version) VALUES(?,'2026-10-02','2026-10-08',?,?,0,'success',?,?)`).run(signal,size,size,source,v1)
    for(const h of [3,5,10])sql.prepare(`INSERT INTO price_horizon_projection_status_v2(signal_date,horizon_days,entry_date,exit_date,
      candidate_count,materialized_count,rejected_count,status,source,projection_version) VALUES(?,?,'2026-10-02','2026-10-08',?,?,0,'success',?,?)`).run(signal,h,size,size,source,v2)
  }
  let queries=0,writes=0
  const db={prepare(query:string){let values:any[]=[];const st={bind(...args:any[]){values=args;return st},
    async all(){queries++;return{success:true,results:sql.prepare(query).all(...values)}},
    async first(){queries++;return sql.prepare(query).get(...values)??null},
    async run(){writes++;throw new Error('readback attempted write')}};return st}}
  const env={DB:db,CF_VERSION_METADATA:{tag:sha,id:'version-A'}} as any
  const keys=size?[{signalDate:signal,horizonDays:5}]:[]
  const canonical={runId:'projection-A',eligibleSignalDates:size?1:0,processedSignalDates:keys.length,skippedCompleteDates:0,
    deferredSignalDates:0,candidateCount:size,materializedCount:size,rejectedCount:0,breadthMaterializedCount:0,status:'success' as const,summary:'terminal',processedHorizonKeys:keys}
  const multiHorizon={horizons:[3,5,10],eligibleSignalDates:size?3:0,processedSignalDates:size?3:0,skippedCompleteDates:0,
    deferredSignalDates:0,candidateCount:size*3,materializedCount:size*3,rejectedCount:0,status:'success' as const,summary:'terminal',
    processedHorizonKeys:size?[3,5,10].map(horizonDays=>({signalDate:signal,horizonDays})):[]}
  const outcomes={asOfDate:businessDate,referenceRows:size,horizons:[3,5,10].map(horizonDays=>({horizonDays,matureRows:size,
    pendingRows:0,unavailableRows:0,persistedRows:size,retiredRows:0})),summary:'terminal'}
  const input={businessDate,canonicalRunId:'finlab-A',projectionRunId:'projection-A',producerResult:{canonical,multiHorizon,outcomes}}
  return{sql,env,input,root,queries:()=>queries,writes:()=>writes}
}

test('formal label/status/run contents are paged and conserved without per-row RPC',async()=>{
  const f=fixture(1200),input={...f.input,task:'price-horizon-projection' as const}
  const proof=await capturePostVerifyLabelEvidence(f.env,input)
  assert.equal(rowProof(proof,'price_horizon_labels_v1')?.rows,1200)
  assert.equal(rowProof(proof,'price_horizon_labels_v2')?.rows,3600)
  assert.ok(f.queries()<40,`bounded page queries=${f.queries()}`)
  assert.equal(f.writes(),0)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,JSON.parse(JSON.stringify(proof))),true)
  f.sql.exec('UPDATE price_horizon_labels_v1 SET exit_raw_close=12 WHERE stock_id=1')
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),false,'same PK/count but different actual content')
  f.sql.close()
})

test('missing labels and wrong processed provenance reject first capture',async()=>{
  const f=fixture(),input={...f.input,task:'price-horizon-projection' as const}
  f.sql.exec('DELETE FROM price_horizon_labels_v1 WHERE stock_id=1')
  await assert.rejects(capturePostVerifyLabelEvidence(f.env,input),/label_count_mismatch/)
  const g=fixture();g.input.producerResult.multiHorizon.processedHorizonKeys[0].signalDate='2026-10-03'
  await assert.rejects(capturePostVerifyLabelEvidence(g.env,{...g.input,task:input.task}),/processed_status_missing/)
  f.sql.close();g.sql.close()
})

test('outcome contents bind original references, canonical producer and exact producer counts',async()=>{
  const f=fixture(),input={...f.input,task:'strategy-multi-horizon-outcomes' as const}
  const proof=await capturePostVerifyLabelEvidence(f.env,input)
  assert.equal(rowProof(proof,'canonical_selection_outcomes_v1')?.rows,9)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),true)
  f.sql.exec('DELETE FROM canonical_selection_outcomes_v1 WHERE symbol=\'1\' AND horizon_days=3')
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),false)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env,input),/outcome_count_mismatch/)
  f.sql.close()
})

test('root/source/canonical changes and receipt tampering cannot reuse actual artifacts',async()=>{
  const f=fixture(),input={...f.input,task:'strategy-multi-horizon-outcomes' as const}
  const proof=await capturePostVerifyLabelEvidence(f.env,input)
  const corrupted=JSON.parse(JSON.stringify(proof));corrupted.tables[0].checksum='forged'
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,corrupted),false)
  f.env.CF_VERSION_METADATA.tag='b'.repeat(40)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),false)
  f.env.CF_VERSION_METADATA.tag=sha
  f.sql.exec("UPDATE pipeline_stage_runs SET canonical_run_id='different'")
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),false)
  f.sql.exec("UPDATE pipeline_stage_runs SET canonical_run_id='finlab-A'")
  f.root('root-B','2026-10-16 02:00:00')
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),false)
  f.sql.close()
})

test('late producer captures read-only artifacts after observer lease/error while exact root and canonical remain',async()=>{
  const f=fixture(),input={...f.input,task:'price-horizon-projection' as const}
  f.sql.exec("UPDATE pipeline_stage_runs SET status='error',lease_expires_at=NULL")
  const proof=await capturePostVerifyLabelEvidence(f.env,input)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),true)
  assert.equal(f.writes(),0)
  f.sql.close()
})

test('temporarily unavailable price inputs retain old outcomes without inventing current writes',async()=>{
  const f=fixture(),input={...f.input,task:'strategy-multi-horizon-outcomes' as const}
  f.sql.exec('DELETE FROM price_horizon_labels_v2 WHERE stock_id=1 AND horizon_days=3')
  const h=f.input.producerResult.outcomes.horizons[0];h.persistedRows=2;h.matureRows=2;h.unavailableRows=1
  const proof=await capturePostVerifyLabelEvidence(f.env,input)
  assert.equal(rowProof(proof,'canonical_selection_outcomes_v1')?.rows,9)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),true)
  f.sql.close()
})

test('legitimate empty products carry explicit empty row checksums, never invented output',async()=>{
  const f=fixture(0)
  for(const task of ['price-horizon-projection','strategy-multi-horizon-outcomes'] as const) {
    const proof=await capturePostVerifyLabelEvidence(f.env,{...f.input,task})
    assert.ok(proof.tables.some(row=>!('kind' in row)&&row.empty&&row.rows===0&&row.pages===0&&row.checksum.length===64))
    assert.equal(await verifyPostVerifyLabelEvidence(f.env,proof),true)
  }
  f.sql.close()
})

test('IO failure or missing published schema throws instead of requesting producer replay',async()=>{
  const f=fixture(),input={...f.input,task:'price-horizon-projection' as const}
  const proof=await capturePostVerifyLabelEvidence(f.env,input)
  const prepare=f.env.DB.prepare.bind(f.env.DB)
  f.env.DB.prepare=(query:string)=>{
    const statement=prepare(query)
    if(!query.includes('FROM price_horizon_labels_v1'))return statement
    let proxy:any
    proxy=new Proxy(statement,{get(target,property){
      if(property==='bind')return(...values:unknown[])=>{target.bind(...values);return proxy}
      if(property==='all')return async()=>{throw new Error('network fetch failed')}
      return Reflect.get(target,property)
    }})
    return proxy
  }
  await assert.rejects(verifyPostVerifyLabelEvidence(f.env,proof),/network fetch failed/)
  f.env.DB.prepare=prepare
  f.sql.exec('DROP TABLE price_horizon_labels_v1')
  await assert.rejects(verifyPostVerifyLabelEvidence(f.env,proof),/no such table/)
  f.sql.close()
})
