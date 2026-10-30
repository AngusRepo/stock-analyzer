import assert from 'node:assert/strict'
import test from 'node:test'
import { isSchedulerRunStatus, classifySchedulerRunSummary, resolveMonotonicSchedulerEntry, type SchedulerRunLogEntry } from './schedulerRunLogger'
import { resolveSchedulerLogStatus } from './schedulerStatus'
import { verifyServingOnlyCallback, runPostcloseResearch } from './postcloseResearch'

test('scheduled postclose work remains waiting, not stale running or successful research',()=>{
  assert.equal(isSchedulerRunStatus('waiting'),true)
  assert.equal(classifySchedulerRunSummary('status=waiting until after market close'),'waiting')
  const entry:SchedulerRunLogEntry={task:'post-pipeline-chain',status:'waiting',summary:'queued_postclose',duration_ms:0,
    timestamp:'2026-10-19T00:00:00Z',run_date:'2026-10-16',run_id:'root'}
  assert.deepEqual(resolveSchedulerLogStatus(entry,{id:'post-pipeline-chain',group:'pipeline_chain'},Date.parse('2026-10-19T05:00:00Z')),
    {status:'waiting',staleRunning:false})
  assert.equal(resolveMonotonicSchedulerEntry({...entry,status:'success'},entry).status,'success')
})

test('serving callback cannot defer validation using an unverified receipt',async()=>{
  const original=globalThis.fetch
  const checksum='a'.repeat(64)
  const env={PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',ML_CONTROLLER_URL:'https://controller.example'} as any
  let actual=checksum;let calls=0
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({publication:{checksum:actual,signal_date:'2026-10-16',run_id:'root'}}),{status:200})}
  try {
    await verifyServingOnlyCallback(env,'2026-10-16','root',checksum)
    actual='b'.repeat(64)
    await assert.rejects(verifyServingOnlyCallback(env,'2026-10-16','root',checksum),/receipt_mismatch/)
    await assert.rejects(verifyServingOnlyCallback(env,'2026-10-16','other-root',actual),/receipt_mismatch/)
    await assert.rejects(verifyServingOnlyCallback(env,'2026-10-16','root','bad'),/callback_invalid/)
    assert.equal(calls,3)
  } finally {globalThis.fetch=original}
})

test('Worker cannot invoke research before the requested trading session closes',async()=>{
  await assert.rejects(runPostcloseResearch({PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any,'2100-01-01'),/before_close/)
})

function noWorkFixture(t:any,premarketState:(url:URL)=>Response,stage:any={business_date:'2026-10-15',canonical_run_id:'root-1015'}) {
  const db={prepare:(sql:string)=>{const st:any={bind:(...args:any[])=>{st.args=args;return st},
    first:async()=>{assert.match(sql,/stage='pipeline_execution' AND business_date<\?/);assert.deepEqual(st.args,['2026-10-16']);return stage}};return st}}
  const env={PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',ML_CONTROLLER_URL:'https://controller.example',
    DB:db,OPS_DB:db} as any
  const urls:string[]=[]
  t.mock.method(globalThis,'fetch',async(input:string)=>{
    const url=new URL(String(input));urls.push(url.pathname+url.search)
    if (url.pathname==='/pipeline/v2/premarket-postclose') return Response.json({trade_date:'2026-10-16',status:'no_published_work',results:[]})
    if (url.pathname==='/pipeline/v2/premarket-state') return premarketState(url)
    throw new Error('unexpected '+url)
  })
  return {env,urls}
}

test('NEW-35: no postclose work with a plan published for the trade date fails loud',async(t)=>{
  const f=noWorkFixture(t,(url)=>{
    assert.equal(url.searchParams.get('date'),'2026-10-15');assert.equal(url.searchParams.get('run_id'),'root-1015')
    return Response.json({status:'sealed',receipt:{},publication:{trade_date:'2026-10-16',signal_date:'2026-10-15',run_id:'root-1015'}})
  })
  await assert.rejects(runPostcloseResearch(f.env,'2026-10-16'),/^Error: postclose_work_missing_for_publication:root-1015$/)
  assert.deepEqual(f.urls,['/pipeline/v2/premarket-postclose','/pipeline/v2/premarket-state?date=2026-10-15&run_id=root-1015'])
})

test('NEW-35: no work and no publication, or a publication for another day, stays a success',async(t)=>{
  let f=noWorkFixture(t,()=>Response.json({status:'waiting',receipt:null,publication:null}))
  assert.equal(await runPostcloseResearch(f.env,'2026-10-16'),'no_published_work; research_jobs=0; publication_check=none_for_trade_date signal_run=root-1015')
  t.mock.restoreAll()
  f=noWorkFixture(t,()=>Response.json({status:'sealed',receipt:{},publication:{trade_date:'2026-10-15'}}))
  assert.match(await runPostcloseResearch(f.env,'2026-10-16'),/^no_published_work; research_jobs=0; publication_check=none_for_trade_date/)
  t.mock.restoreAll()
  f=noWorkFixture(t,()=>{throw new Error('premarket-state must not be read without a prior pipeline run')},null)
  assert.equal(await runPostcloseResearch(f.env,'2026-10-16'),'no_published_work; research_jobs=0; publication_check=no_prior_pipeline_execution')
})

test('NEW-35: an unreadable premarket state is unverifiable and fails loud',async(t)=>{
  const f=noWorkFixture(t,()=>new Response('boom',{status:500}))
  await assert.rejects(runPostcloseResearch(f.env,'2026-10-16'),/^Error: postclose_publication_state_unverifiable:root-1015:/)
  t.mock.restoreAll()
  // A prior execution row without its canonical run id cannot be checked either.
  const g=noWorkFixture(t,()=>{throw new Error('premarket-state needs a run id')},{business_date:'2026-10-15',canonical_run_id:null})
  await assert.rejects(runPostcloseResearch(g.env,'2026-10-16'),/^Error: postclose_publication_state_unverifiable:2026-10-15:canonical_run_id_missing$/)
  assert.deepEqual(g.urls,['/pipeline/v2/premarket-postclose'])
})

test('NEW-35: the premarket owner switch still skips before any controller call',async(t)=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('no fetch expected')})
  assert.equal(await runPostcloseResearch({PAPER_DAILY_PLAN_OWNER:'legacy'} as any,'2026-10-16'),'SKIP: premarket owner disabled')
  assert.equal(fetch.mock.callCount(),0)
})
