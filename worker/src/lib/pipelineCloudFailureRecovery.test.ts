import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import type { Bindings } from '../types'
import { acceptPipelineExecutionCallback, commitPipelineExecutionDispatch, reservePipelineExecutionDispatch } from './pipelineStageLease'
import { enqueuePostScreenerPipelineRecovery, pipelineProvenanceRecoveryDecision, reconcilePipelineCloudFailure } from './postScreenerContinuation'

const day='2026-09-18'
const execution='projects/p/locations/r/jobs/pipeline-v2/executions/pipeline-v2-one'
const error='pipeline_cloud_run_failed:memory_limit;completed_at=2026-09-18T14:42:00+00:00;execution=pipeline-v2-one'

test('Cloud failure recovery uses terminal time, requires newer release and never treats generic error as OOM',()=>{
  const input={failure:{canonical_run_id:'run-a',status:'error',last_error:error,updated_at:'2026-09-19 15:00:00'},
    workerVersion:{id:'release',tag:'a'.repeat(40),timestamp:'2026-09-19T13:00:00Z'}}
  assert.equal(pipelineProvenanceRecoveryDecision(input).retry,true)
  assert.equal(pipelineProvenanceRecoveryDecision({...input,workerVersion:{...input.workerVersion,timestamp:'2026-09-18T13:00:00Z'}}).retry,false)
  assert.equal(pipelineProvenanceRecoveryDecision({...input,failure:{...input.failure,last_error:'random error'}}).retry,false)
})

test('real D1 retains expired authority, stores execution identity, and deduplicates failure recovery',async()=>{
  const mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("ok")} }',d1Databases:['OPS']})
  const originalFetch=globalThis.fetch
  try {
    const db=await mf.getD1Database('OPS')
    await db.prepare(`CREATE TABLE pipeline_stage_runs (
      business_date TEXT, stage TEXT, canonical_run_id TEXT, status TEXT, cursor_key TEXT,
      processed_count INTEGER DEFAULT 0,expected_count INTEGER,persisted_count INTEGER DEFAULT 0,
      attempt_count INTEGER DEFAULT 0,lease_owner TEXT,lease_expires_at TEXT,queued_at TEXT,
      started_at TEXT,completed_at TEXT,last_error TEXT,updated_at TEXT,
      PRIMARY KEY(business_date,stage));`).run()
    await reservePipelineExecutionDispatch(db as any,{businessDate:day,attemptId:'run-a'})
    await commitPipelineExecutionDispatch(db as any,{businessDate:day,attemptId:'run-a',runId:'run-a',executionName:execution})
    await db.prepare("UPDATE pipeline_stage_runs SET lease_expires_at='2020-01-01'").run()
    assert.equal(await reservePipelineExecutionDispatch(db as any,{businessDate:day,attemptId:'run-b'}),null)
    const held=await db.prepare('SELECT * FROM pipeline_stage_runs').first<any>()
    assert.equal(held.cursor_key,execution);assert.equal(held.canonical_run_id,'run-a')
    await db.prepare("INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,updated_at) VALUES (?,'post_screener_continuation','root','success',CURRENT_TIMESTAMP)").bind(day).run()
    const kv=new Map<string,string>();const sent:unknown[]=[]
    const env={DB:db,OPS_DB:db,ML_CONTROLLER_URL:'https://controller.invalid',ML_CONTROLLER_SECRET:'fixture',
      CF_VERSION_METADATA:{id:'release',tag:'a'.repeat(40),timestamp:'2026-09-19T13:00:00Z'},
      KV:{get:async(k:string)=>{const v=kv.get(k);return v?JSON.parse(v):null},put:async(k:string,v:string)=>{kv.set(k,v)}},
      UPDATE_QUEUE:{send:async(m:unknown)=>{sent.push(m)}}} as unknown as Bindings
    let state='succeeded';let requests=0
    globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input));assert.equal(url.pathname,'/pipeline/v2/reconcile')
      assert.equal(url.searchParams.get('run_id'),'run-a');assert.equal(url.searchParams.get('execution_name'),execution)
      assert.equal(init?.method,'POST');requests++
      if(state==='failed') await acceptPipelineExecutionCallback(db as any,{businessDate:day,runId:'run-a',status:'error',error})
      return Response.json({schema_version:'pipeline-cloud-execution-status-v1',run_id:'run-a',run_date:day,state,
        reason:'awaiting_pipeline_callback',failure_callback_sent:state==='failed'})
    }
    await reconcilePipelineCloudFailure(env,day)
    assert.equal((await db.prepare('SELECT status FROM pipeline_stage_runs WHERE stage=?').bind('pipeline_execution').first<any>())?.status,'waiting')
    assert.equal(sent.length,0)
    state='failed'
    const results=await Promise.all(Array.from({length:4},()=>enqueuePostScreenerPipelineRecovery(env,{businessDate:day,workerVersion:env.CF_VERSION_METADATA,source:'test'})))
    assert.equal(results.filter(x=>x.queued).length,1);assert.equal(sent.length,1);assert.ok(requests>=2)
    // A duplicate callback can repair callback-side closure, but cannot enqueue twice.
    await enqueuePostScreenerPipelineRecovery(env,{businessDate:day,workerVersion:env.CF_VERSION_METADATA,source:'test'})
    assert.equal(sent.length,1)
  } finally {globalThis.fetch=originalFetch;await mf.dispose()}
})
