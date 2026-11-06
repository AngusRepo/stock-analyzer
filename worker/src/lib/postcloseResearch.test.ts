import assert from 'node:assert/strict'
import test from 'node:test'
import { isSchedulerRunStatus, classifySchedulerRunSummary, logSchedulerRunResult, resolveMonotonicSchedulerEntry, type SchedulerRunLogEntry } from './schedulerRunLogger'
import { postcloseDispatchTwTime } from './schedulerManifestGovernance'
import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
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

test('serving callback names the trade date dispatch the root waits for',async(t)=>{
  const checksum='a'.repeat(64)
  const env={PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',ML_CONTROLLER_URL:'https://controller.example'} as any
  let tradeDate:string|undefined='2026-11-02'
  t.mock.method(globalThis,'fetch',async()=>Response.json({publication:{checksum,signal_date:'2026-10-30',run_id:'root',trade_date:tradeDate}}))
  assert.equal(await verifyServingOnlyCallback(env,'2026-10-30','root',checksum),'2026-11-02T14:20:00+08:00')
  // An old receipt without a later trade date keeps the previous behavior: no wait window.
  tradeDate=undefined
  assert.equal(await verifyServingOnlyCallback(env,'2026-10-30','root',checksum),undefined)
  tradeDate='2026-10-30'
  assert.equal(await verifyServingOnlyCallback(env,'2026-10-30','root',checksum),undefined)
})

test('the dispatch time is read from the scheduler manifest',()=>{
  assert.equal(postcloseDispatchTwTime(),'14:20')
  assert.equal(postcloseDispatchTwTime({timeZone:'UTC',jobs:[{id:'postclose-research-dispatch',schedule:'5 7 * * 1-5'}]}),'15:05')
  assert.throws(()=>postcloseDispatchTwTime({timeZone:'UTC',jobs:[]}),/postclose_dispatch_schedule_invalid/)
  assert.throws(()=>postcloseDispatchTwTime({timeZone:'Asia/Taipei',jobs:[{id:'postclose-research-dispatch',schedule:'20 6 * * 1-5'}]}),/postclose_dispatch_schedule_invalid/)
})

test('a root parked on the dispatch waits until then and its stall SLA starts there',async()=>{
  const root:SchedulerRunLogEntry={task:'evening-chain',status:'running',summary:'research waits for the after-close dispatch at 2026-11-02 14:20',
    duration_ms:0,timestamp:'2026-11-01T23:34:37Z',run_date:'2026-10-30',run_id:'root',wait_until:'2026-11-02T14:20:00+08:00'}
  const def={id:'evening-chain',group:'pipeline_chain' as const}
  assert.deepEqual(resolveSchedulerLogStatus(root,def,Date.parse('2026-11-02T01:44:00Z')),{status:'waiting',staleRunning:false})
  assert.deepEqual(resolveSchedulerLogStatus(root,def,Date.parse('2026-11-02T07:30:00Z')),{status:'running',staleRunning:false})
  const missed=resolveSchedulerLogStatus(root,def,Date.parse('2026-11-02T07:51:00Z'))
  assert.equal(missed.status,'failed')
  assert.match(missed.staleReason??'',/^stale running: no final callback after 1h31m; SLA 1h30m$/)
  // Without wait_until the old SLA from the log time still applies.
  const {wait_until:_, ...plain}=root
  assert.equal(resolveSchedulerLogStatus(plain,def,Date.parse('2026-11-02T01:44:00Z')).status,'failed')
})

test('the run logger keeps wait_until on the stored entry',async()=>{
  const store=new Map<string,string>()
  const kv={get:async(k:string)=>store.has(k)?JSON.parse(store.get(k)!):null,put:async(k:string,v:string)=>{store.set(k,v)}} as any
  await logSchedulerRunResult(kv,'evening-chain',{status:'running',summary:'parked',duration_ms:0,run_id:'root',run_date:'2026-10-30',
    wait_until:'2026-11-02T14:20:00+08:00'})
  assert.equal(JSON.parse(store.get('scheduler:run:evening-chain:2026-10-30')!).wait_until,'2026-11-02T14:20:00+08:00')
})

test('a bad dispatch schedule leaves no wait window instead of failing the serving callback',async(t)=>{
  const checksum='a'.repeat(64)
  const env={PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',ML_CONTROLLER_URL:'https://controller.example'} as any
  t.mock.method(globalThis,'fetch',async()=>Response.json({publication:{checksum,signal_date:'2026-10-30',run_id:'root',trade_date:'2026-11-02'}}))
  const manifest=schedulerManifest as any
  const job=manifest.jobs.find((row:any)=>row.id==='postclose-research-dispatch')
  const schedule=job.schedule
  job.schedule='bad'
  try {assert.equal(await verifyServingOnlyCallback(env,'2026-10-30','root',checksum),undefined)}
  finally {job.schedule=schedule}
})
