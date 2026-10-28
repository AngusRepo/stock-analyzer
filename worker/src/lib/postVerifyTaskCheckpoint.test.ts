import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPostVerifyTaskCheckpoints, postVerifyOwnerAckEvidence, postVerifyAckDescriptor, type PostVerifyTaskResult } from './postVerifyTaskCheckpoint'
import { runPostVerifyCallbackChain } from './postMarketChain'
import { controllerFetch } from './controllerClient'
import { claimPipelineStage, markPipelineStageFenced } from './pipelineStageLease'
import { sendReportToChannels } from './notify'
import { capturePostVerifyOwnerEvidence, verifyPostVerifyOwnerEvidence } from './postVerifyOwnerEvidence'
import { recordPaperActivePostmarketReport } from './paperActiveChallenger'

const date = '2026-10-16', run = 'canonical-A', source = 'a'.repeat(40)
const tasks = ['price-horizon-projection','strategy-multi-horizon-outcomes','strategy-evidence-current',
  'strategy-evidence-metric-backfill','model-ic-rolling','artifact-auto-promotion','s12-replay-backfill',
  'paper-intraday-cache-clear','linucb-reward-ledger','adapt','daily-report','paper-active-postmarket',
  'obsidian-sync','meta-learning-shadow','ga-shadow-daily','strategy-learning']

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql','utf8'))
  sqlite.exec(readFileSync('domain-migrations/ops/0023_post_verify_task_receipts.sql','utf8'))
  sqlite.exec(`CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,
    lease_owner TEXT,lease_expires_at TEXT,cursor_key TEXT,processed_count INTEGER DEFAULT 0,expected_count INTEGER,
    persisted_count INTEGER DEFAULT 0,attempt_count INTEGER DEFAULT 0,queued_at TEXT,started_at TEXT,completed_at TEXT,
    last_error TEXT,updated_at TEXT,PRIMARY KEY(business_date,stage)); CREATE TABLE writes(id INTEGER PRIMARY KEY,value TEXT);`)
  sqlite.prepare('INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,lease_owner,lease_expires_at) VALUES(?,?,?,?,?,?)').run(date,'post_verify_chain',run,'running','lease-A','2099-01-01')
  const root = (id:string,updated:string) => sqlite.prepare(`INSERT INTO scheduler_execution_tickets_v1
    (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,updated_at)
    VALUES(?,?,?,'evening-chain','evening-chain',?,?,'attempt','physical_root','running','scheduler_http','checksum',?)`)
    .run(id,id,id,date,run,updated)
  root('root-A','2026-10-16 01:00:00')
  let queries = 0
  const db = { prepare(sql:string) {
    let args:any[]=[]
    const statement = { bind(...values:any[]) { args=values;return statement },
      async first(column?:string) { queries++; const row=sqlite.prepare(sql).get(...args) as any;return column ? row?.[column] ?? null:row ?? null },
      async all() { queries++;return {results:sqlite.prepare(sql).all(...args),success:true} },
      async raw() { queries++;return sqlite.prepare(sql).all(...args).map(row=>Object.values(row)) },
      async run() { queries++;return {success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}} } }
    return statement
  }, async batch(statements:any[]) { const out=[]; for(const statement of statements)out.push(await statement.run());return out },
  async exec(sql:string) { sqlite.exec(sql);return {success:true} } }
  const kv=new Map<string,string>(), enqueued:any[]=[], effects:string[]=[]
  const env={DB:db,OPS_DB:db,MULTI_D1_ACTIVE_DOMAINS:'ops',CF_VERSION_METADATA:{tag:source,id:'version-A',timestamp:'now'},
    KV:{get:async(key:string,type?:string)=>{const value=kv.get(key);return value==null?null:type==='json'?JSON.parse(value):value},
      put:async(key:string,value:string)=>{kv.set(key,value);effects.push('kv')},delete:async(key:string)=>kv.delete(key)},
    UPDATE_QUEUE:{send:async(value:any)=>{enqueued.push(value);effects.push('queue')}},
    ARTIFACTS:{put:async()=>{effects.push('r2')},delete:async()=>{effects.push('r2-delete')}},
    EVIDENCE_ARTIFACT_WRITER:{write:async()=>{effects.push('artifact-writer');return {status:'ready'}}},
    ML_CONTROLLER_URL:'https://never-network.invalid', ENVIRONMENT:'test'} as any
  const ctx={runDate:date,upstreamRunId:run,stageLeaseOwner:'lease-A',assertStageLease:async()=>{}}
  const authority=async()=>({allowed:true,runScope:'live_canonical' as const,reason:'fixture',queuedAt:'now',queuedTaipeiDate:date,nextSessionOpenUtc:null})
  const manager=()=>createPostVerifyTaskCheckpoints(env,{businessDate:date,canonicalRunId:run,leaseOwner:'lease-A',productionEligible:true,assertStageLease:ctx.assertStageLease})
  return {sqlite,env,ctx,authority,manager,root,enqueued,effects,queries:()=>queries}
}
const success=(task:string):PostVerifyTaskResult=>({task,status:'success',summary:`${task} validated`,critical:true})

test('actual post-verify owner preserves order and reuses successful phases after a later failure',async()=>{
  const f=fixture(), calls:string[]=[]
  let fail=true
  const taskRunner=async(task:string)=>{calls.push(task);if(task==='strategy-multi-horizon-outcomes'&&fail)return {...success(task),status:'error' as const,summary:'injected'};return success(task)}
  await assert.rejects(runPostVerifyCallbackChain(f.env,f.ctx,{productionAuthority:f.authority,taskRunner}),/post_verify_chain_failed/)
  fail=false
  assert.equal(await runPostVerifyCallbackChain(f.env,f.ctx,{productionAuthority:f.authority,taskRunner}),'success')
  assert.equal(calls.filter(x=>x===tasks[0]).length,1)
  assert.equal(calls.filter(x=>x===tasks[1]).length,2)
  assert.deepEqual(calls.slice(2),tasks.slice(1))
  const before=calls.length
  await runPostVerifyCallbackChain(f.env,f.ctx,{productionAuthority:f.authority,taskRunner})
  assert.equal(calls.length,before)
  f.sqlite.close()
})

for(const failedTask of tasks) test(`actual owner injects settled failure at ${failedTask}; no prior work repeats`,async()=>{
  const f=fixture(), calls=new Map<string,number>()
  const taskRunner=async(task:string)=>{calls.set(task,(calls.get(task)??0)+1);return task===failedTask?{...success(task),status:'error' as const,summary:'injected terminal failure'}:success(task)}
  await runPostVerifyCallbackChain(f.env,f.ctx,{productionAuthority:f.authority,taskRunner}).catch(()=>{})
  await runPostVerifyCallbackChain(f.env,f.ctx,{productionAuthority:f.authority,taskRunner}).catch(()=>{})
  for(const task of tasks.slice(0,tasks.indexOf(failedTask))) assert.equal(calls.get(task),1,task)
  const receipt=f.sqlite.prepare(`SELECT state,receipt_json FROM post_verify_task_receipts_v1 WHERE json_extract(receipt_json,'$.task')=? LIMIT 1`).get(failedTask) as any
  assert.equal(receipt.state,'post_verify_task_v1:error')
  assert.equal(JSON.parse(receipt.receipt_json).result.status,'error')
  if(![...tasks.slice(0,2),'linucb-reward-ledger'].includes(failedTask)) assert.equal(calls.get(failedTask),1,'non-idempotent failed phase must not blindly run again')
  f.sqlite.close()
})

test('partial idempotent batch writes resume without replaying previous phase',async()=>{
  const f=fixture(), manager=await f.manager()
  await manager.run('before',async()=>success('before'))
  await assert.rejects(manager.run('projection',async env=>{
    await env.OPS_DB!.batch([env.OPS_DB!.prepare('INSERT INTO writes VALUES(?,?)').bind(1,'a')])
    throw new Error('partial write')
  },{retrySafe:true}),/partial write/)
  const result=await manager.run('projection',async env=>{
    await env.OPS_DB!.batch([env.OPS_DB!.prepare('INSERT OR REPLACE INTO writes VALUES(?,?)').bind(1,'a'),env.OPS_DB!.prepare('INSERT INTO writes VALUES(?,?)').bind(2,'b')])
    return success('projection')
  },{retrySafe:true})
  assert.equal(result.status,'success')
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) n FROM writes').get() as any).n,2)
  f.sqlite.close()
})

test('timeout is unresolved until original producer settles; duplicate root cannot re-enter',async()=>{
  const f=fixture(), manager=await f.manager()
  let release!:(value:PostVerifyTaskResult)=>void
  const pending=new Promise<PostVerifyTaskResult>(resolve=>{release=resolve})
  await assert.rejects(manager.run('slow',async()=>pending,{timeoutMs:2}),/timeout_unsettled/)
  const second=await f.manager()
  let repeated=0
  await assert.rejects(second.run('slow',async()=>{repeated++;return success('slow')}),/unsettled_side_effect/)
  assert.equal(repeated,0)
  release(success('slow'))
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(f.enqueued[0]?.runId,run)
  assert.equal((await second.run('slow',async()=>{repeated++;return success('slow')})).status,'success')
  assert.equal(repeated,0)
  f.sqlite.close()
})

test('lease loss fences DB/KV/R2/queue/controller writes while pending claim stays exclusive',async()=>{
  const f=fixture(), manager=await f.manager()
  let scope:any
  await manager.run('capture',async env=>{scope=env;return success('capture')})
  // Closed scope must also reject late detached writes.
  for(const effect of [()=>scope.DB.prepare('INSERT INTO writes VALUES(3,\'bad\')').run(),
    ()=>scope.KV.put('bad','bad'),()=>scope.ARTIFACTS.put('bad','bad'),()=>scope.UPDATE_QUEUE.send({}),
    ()=>scope.EVIDENCE_ARTIFACT_WRITER.write({}),
    ()=>controllerFetch(scope,'/mutation',{method:'POST'})]) await assert.rejects(effect,/task_closed/)
  assert.equal(f.effects.length,0)
  const next=await f.manager()
  await assert.rejects(next.run('lost',async env=>{
    f.sqlite.prepare("UPDATE pipeline_stage_runs SET lease_owner='other'").run()
    await env.DB.prepare('INSERT INTO writes VALUES(4,\'bad\')').run()
    return success('lost')
  }),/authority_lost/)
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) n FROM writes').get() as any).n,0)
  f.sqlite.close()
})

test('claim statement atomically rejects a root change after the first authority read',async()=>{
  const f=fixture(), manager=await f.manager(), prepare=f.env.OPS_DB.prepare.bind(f.env.OPS_DB)
  let changed=false, starts=0
  f.env.OPS_DB.prepare=(sql:string)=>{
    if(!changed&&sql.startsWith('INSERT INTO post_verify_task_receipts_v1')){
      changed=true;f.root('root-between-check-and-claim','2026-10-16 05:00:00')
    }
    return prepare(sql)
  }
  await assert.rejects(manager.run('phase',async()=>{starts++;return success('phase')}),/unsettled_side_effect/)
  assert.equal(starts,0)
  f.sqlite.close()
})

test('actual owner timeout survives real stage error/lease clear and late original terminal completion',async()=>{
  const f=fixture(), calls:string[]=[]
  let finish!:(value:PostVerifyTaskResult)=>void
  const pending=new Promise<PostVerifyTaskResult>(resolve=>{finish=resolve})
  const actualLeaseGuard=async()=>{
    const row=f.sqlite.prepare("SELECT 1 ok FROM pipeline_stage_runs WHERE status='running' AND lease_owner='lease-A'").get()
    if(!row)throw new Error('pipeline_stage_lease_lost:fixture')
  }
  const ctx={...f.ctx,assertStageLease:actualLeaseGuard}
  const taskRunner=async(task:string)=>{calls.push(task);return task===tasks[0]?pending:success(task)}
  await assert.rejects(runPostVerifyCallbackChain(f.env,ctx,{productionAuthority:f.authority,taskRunner,taskTimeoutMs:2}),/timeout_unsettled/)
  assert.equal(await markPipelineStageFenced(f.env.OPS_DB,{businessDate:date,stage:'post_verify_chain',canonicalRunId:run,
    leaseOwner:'lease-A',status:'error',error:'outer timeout'}),true)
  finish(success(tasks[0]))
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(f.enqueued[0]?.runId,run)
  f.sqlite.prepare("UPDATE pipeline_stage_runs SET status='queued' WHERE business_date=?").run(date)
  const claimed=await claimPipelineStage(f.env.OPS_DB,{businessDate:date,stage:'post_verify_chain',canonicalRunId:run,ownerId:'lease-A'})
  assert.ok(claimed)
  assert.equal(await runPostVerifyCallbackChain(f.env,ctx,{productionAuthority:f.authority,taskRunner}),'success')
  assert.equal(calls.filter(task=>task===tasks[0]).length,1,'original late-success producer must not repeat')
  f.sqlite.close()
})

test('same-date new root or new revision cannot reuse old successful receipt',async()=>{
  const f=fixture()
  await (await f.manager()).run('phase',async()=>success('phase'))
  f.root('root-B','2026-10-16 02:00:00')
  let reruns=0
  await (await f.manager()).run('phase',async()=>{reruns++;return success('phase')})
  f.env.CF_VERSION_METADATA={tag:'b'.repeat(40),id:'version-B',timestamp:'now'}
  await (await f.manager()).run('phase',async()=>{reruns++;return success('phase')})
  assert.equal(reruns,2)
  f.sqlite.close()
})

test('tampered stored checksum fails closed before another producer starts',async()=>{
  const f=fixture()
  await (await f.manager()).run('phase',async()=>success('phase'))
  f.sqlite.prepare("UPDATE post_verify_task_receipts_v1 SET receipt_json=json_set(receipt_json,'$.result.summary','forged')").run()
  await assert.rejects((await f.manager()).run('phase',async()=>success('phase')),/corrupt/)
  f.sqlite.close()
})

test('one batch adds one write-fence read rather than one per row',async()=>{
  const f=fixture(), manager=await f.manager()
  let cost=0
  await manager.run('batch',async env=>{
    const before=f.queries()
    await env.OPS_DB!.batch(Array.from({length:20},(_,i)=>env.OPS_DB!.prepare('INSERT INTO writes VALUES(?,?)').bind(i,String(i))))
    cost=f.queries()-before
    return success('batch')
  })
  assert.equal(cost,21,'20 producer writes + one batch authority check')
  f.sqlite.close()
})

test('unknown remote side effects stay uncertain across new root/revision and never redispatch',async()=>{
  const f=fixture(), manager=await f.manager()
  await manager.run('promotion',async()=>({...success('promotion'),status:'error',summary:'Controller HTTP 502: connection lost'}))
  const row=f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any
  assert.equal(row.state,'post_verify_task_v1:uncertain')
  f.root('new-root','2026-10-16 03:00:00')
  f.env.CF_VERSION_METADATA={tag:'c'.repeat(40),id:'version-C',timestamp:'now'}
  let repeats=0
  await assert.rejects((await f.manager()).run('promotion',async()=>{repeats++;return success('promotion')}),/unsettled_side_effect/)
  assert.equal(repeats,0)
  f.sqlite.close()
})

test('stale old-root producer cannot write new data or wake a new root',async()=>{
  const f=fixture(), manager=await f.manager()
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  await assert.rejects(manager.run('old',async env=>{
    await gate
    await env.DB.prepare('INSERT INTO writes VALUES(9,\'stale\')').run()
    return success('old')
  },{timeoutMs:2}),/timeout_unsettled/)
  f.root('root-new','2026-10-16 04:00:00')
  release()
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) n FROM writes').get() as any).n,0)
  assert.equal(f.enqueued.length,0)
  const old=f.sqlite.prepare('SELECT receipt_json FROM post_verify_task_receipts_v1').get() as any
  assert.equal(JSON.parse(old.receipt_json).identity.rootTicketId,'root-A')
  assert.equal(JSON.parse(old.receipt_json).result.status,'error')
  f.sqlite.close()
})

test('receipt write acknowledged late still reuses actual readback rather than repeating producer',async()=>{
  const f=fixture(), original=f.env.OPS_DB.prepare.bind(f.env.OPS_DB)
  let interrupted=true, calls=0
  f.env.OPS_DB.prepare=(sql:string)=>{
    const statement=original(sql)
    if(sql.startsWith('UPDATE post_verify_task_receipts_v1')){
      const first=statement.first.bind(statement)
      statement.first=async()=>{const result=await first();if(interrupted){interrupted=false;throw new Error('fixture response lost after durable write')}return result}
    }
    return statement
  }
  const manager=await f.manager()
  await assert.rejects(manager.run('persist',async()=>{calls++;return success('persist')}),/response lost/)
  const result=await (await f.manager()).run('persist',async()=>{calls++;return success('persist')})
  assert.equal(result.status,'success');assert.equal(calls,1)
  f.sqlite.close()
})

test('fresh artifact validator detects deletion and idempotent owner repairs actual output',async()=>{
  const f=fixture();let calls=0
  const produce=async(env:any)=>{calls++;await env.DB.prepare('INSERT OR REPLACE INTO writes VALUES(1,\'valid\')').run();return success('artifact')}
  const options={retrySafe:true,verifyResult:async()=>Boolean(f.sqlite.prepare("SELECT 1 FROM writes WHERE id=1 AND value='valid'").get())}
  await (await f.manager()).run('artifact',produce,options)
  f.sqlite.prepare('DELETE FROM writes').run()
  await (await f.manager()).run('artifact',produce,options)
  assert.equal(calls,2)
  assert.equal((f.sqlite.prepare('SELECT value FROM writes').get() as any).value,'valid')
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) n FROM post_verify_task_receipts_v1 WHERE receipt_key LIKE '%:invalidated:%'").get() as any).n,1)
  f.sqlite.close()
})

test('unavailable readback does not invalidate receipt or allocate another producer',async()=>{
  const f=fixture();let calls=0
  const produce=async()=>{calls++;return success('artifact')}
  await (await f.manager()).run('artifact',produce)
  await assert.rejects((await f.manager()).run('artifact',produce,{retrySafe:true,verifyResult:async()=>{throw new Error('fixture readback network unavailable')}}),/network unavailable/)
  assert.equal(calls,1)
  assert.equal((f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any).state,'post_verify_task_v1:success')
  f.sqlite.close()
})

test('lost lease during awaited fresh verification cannot invalidate a new owners success alias',async()=>{
  const f=fixture();let calls=0
  const producer=async()=>{calls++;return success('artifact')}
  await (await f.manager()).run('artifact',producer)
  await assert.rejects((await f.manager()).run('artifact',producer,{retrySafe:true,verifyResult:async()=>{
    f.sqlite.exec("UPDATE pipeline_stage_runs SET lease_owner='lease-B'")
    return false
  }}),/authority_lost_during_invalidation/)
  assert.equal((f.sqlite.prepare("SELECT state FROM post_verify_task_receipts_v1 WHERE receipt_key NOT LIKE '%:invalidated:%'").get() as any).state,'post_verify_task_v1:success')
  const next=await createPostVerifyTaskCheckpoints(f.env,{businessDate:date,canonicalRunId:run,leaseOwner:'lease-B',
    productionEligible:true,assertStageLease:async()=>{}})
  await next.run('artifact',producer,{retrySafe:true,verifyResult:async()=>true})
  assert.equal(calls,1)
  f.sqlite.close()
})

test('five hundred D1 acknowledgements keep receipt bounded and finish success',async()=>{
  const f=fixture()
  await (await f.manager()).run('capacity',async env=>{
    await env.DB.batch(Array.from({length:500},(_,i)=>env.DB.prepare('INSERT INTO writes VALUES(?,?)').bind(i,String(i))))
    return {...success('capacity'),evidence:await postVerifyOwnerAckEvidence(env)}
  })
  const row=f.sqlite.prepare('SELECT state,receipt_json FROM post_verify_task_receipts_v1').get() as any
  assert.equal(row.state,'post_verify_task_v1:success')
  assert.ok(Buffer.byteLength(row.receipt_json)<4096)
  f.sqlite.close()
})

test('binary acknowledgement hashes actual bytes without JSON numeric-key expansion',async()=>{
  const first=new Uint8Array([1,2,3]),second=new Uint8Array([1,2,4])
  const a=await postVerifyAckDescriptor(first.buffer),b=await postVerifyAckDescriptor(first),c=await postVerifyAckDescriptor(second)
  assert.equal(a.content_sha256,b.content_sha256)
  assert.notEqual(a.content_sha256,c.content_sha256)
  assert.equal(a.byte_length,3)
  const large=await postVerifyAckDescriptor(new Uint8Array(8*1024*1024))
  assert.ok(JSON.stringify(large).length<200)
})

test('stream acknowledgements remain explicitly unverified and retain provider witness',async()=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));controller.close()}})
  const descriptor=await postVerifyAckDescriptor(stream)
  assert.equal(descriptor.kind,'stream');assert.equal(descriptor.content_sha256,null)
  assert.equal(descriptor.content_unverified,true);assert.equal(stream.locked,false)
  const f=fixture()
  f.env.ARTIFACTS.put=async(key:string)=>({key,etag:'provider-etag',size:1,checksums:{sha256:new Uint8Array([1,2]).buffer}})
  await (await f.manager()).run('stream',async env=>{
    await env.ARTIFACTS!.put('actual-key',stream)
    return {...success('stream'),evidence:await postVerifyOwnerAckEvidence(env)}
  })
  const proof=JSON.parse((f.sqlite.prepare('SELECT receipt_json FROM post_verify_task_receipts_v1').get() as any).receipt_json).result.evidence
  const witness=proof.owners.find((row:any)=>row.kind==='storage').owner
  assert.equal(witness.requires_artifact_readback,true)
  assert.equal(witness.provider_objects[0].key,'actual-key')
  assert.equal(witness.provider_objects[0].checksums.sha256.kind,'binary')
  f.sqlite.close()
})

test('confirmed optional artifact loss is visible error without replaying downstream side effects',async()=>{
  const f=fixture();let previousCalls=0,laterCalls=0
  let valid=true
  const first=async()=>{previousCalls++;return {...success('optional'),critical:false}}
  const last=async()=>{laterCalls++;return success('later')}
  const options={critical:false,verifyResult:async()=>valid}
  const a=await f.manager();await a.run('optional',first,options);await a.run('later',last)
  valid=false
  const b=await f.manager()
  const observed=await b.run('optional',first,options)
  assert.equal(observed.status,'error');assert.equal(observed.critical,false)
  await b.run('later',last)
  assert.equal(previousCalls,1);assert.equal(laterCalls,1)
  f.sqlite.close()
})

test('scoped report rejects failed provider delivery instead of recording a false ACK',async()=>{
  const f=fixture(),previous=globalThis.fetch
  f.env.DISCORD_WEBHOOK_URL='https://fixture-not-a-real-provider.invalid'
  globalThis.fetch=async()=>new Response('fixture unavailable',{status:503})
  try{
    await assert.rejects((await f.manager()).run('delivery',async env=>{
      await sendReportToChannels(env as any,[{description:'fixture'}],'fixture')
      return success('delivery')
    }),/HTTP503/)
    assert.equal((f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any).state,'post_verify_task_v1:uncertain')
  }finally{globalThis.fetch=previous;f.sqlite.close()}
})

test('report fresh proof detects deleted actual report and never repeats delivered notification',async()=>{
  const f=fixture(),previous=globalThis.fetch
  f.sqlite.exec(`CREATE TABLE stock_analysis_reports(date TEXT,report_type TEXT,market_summary TEXT,ml_overview TEXT,
    buy_details TEXT,sell_alerts TEXT,recommendations TEXT,performance TEXT,theme_flow TEXT,PRIMARY KEY(date,report_type));`)
  f.env.DISCORD_WEBHOOK_URL='https://fixture-not-a-real-provider.invalid'
  let notifications=0
  globalThis.fetch=async()=>{notifications++;return new Response(null,{status:204})}
  const produce=async(env:any)=>{
    await env.DB.prepare("INSERT INTO stock_analysis_reports VALUES(?,'daily','{}','{}','[]','[]','[]','{}','[]')").bind(date).run()
    await sendReportToChannels(env,[{description:'fixture'}],'fixture')
    const result=success('daily-report')
    return {...result,evidence:await capturePostVerifyOwnerEvidence(env,'daily-report',date,result)}
  }
  const options={verifyResult:(result:PostVerifyTaskResult)=>verifyPostVerifyOwnerEvidence(f.env,'daily-report',date,result)}
  try{
    await (await f.manager()).run('daily-report',produce,options)
    f.sqlite.exec('DELETE FROM stock_analysis_reports')
    await assert.rejects((await f.manager()).run('daily-report',produce,options),/artifact_changed_requires_reconciliation/)
    assert.equal(notifications,1)
  }finally{globalThis.fetch=previous;f.sqlite.close()}
})

test('Paper owner proof reads actual candidate/metric/audit rows and never repeats optional mutation',async()=>{
  const f=fixture(),previous=globalThis.fetch
  const ddl=readFileSync('domain-schemas/paper.sql','utf8')
  for(const table of ['paper_challenger_candidates','paper_challenger_daily_metrics','promotion_audit_events']){
    const definition=ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert.ok(definition);f.sqlite.exec(definition[0])
  }
  const report={generated_at:date+'T21:00:00Z',candidate_count:1,evaluated_count:1,real_trading_effect:'none',
    promotion_packets:[{candidate_id:'candidate-1',candidate_type:'fixture',current_state:'paper_active_challenger',decision:'hold',
      challenger_metrics:{paper_decision_count:4,hit_rate:0.5,regime_split_passed:true}}],
    audit_events:[{candidate_id:'candidate-1',decision:'hold',to_state:'paper_active_challenger',packet:{reason:'fixture'},real_trading_effect:'none'}]}
  let requests=0
  globalThis.fetch=async()=>{requests++;return Response.json(report)}
  const produce=async(env:any)=>{
    const response=await controllerFetch(env,'/paper_challenger/postmarket_report',{method:'POST',jsonBody:{run_date:date}})
    await recordPaperActivePostmarketReport(env,await response.json())
    const result=success('paper-active-postmarket')
    return {...result,critical:false,evidence:await capturePostVerifyOwnerEvidence(env,'paper-active-postmarket',date,result)}
  }
  const options={critical:false,verifyResult:(result:PostVerifyTaskResult)=>verifyPostVerifyOwnerEvidence(f.env,'paper-active-postmarket',date,result)}
  try{
    await (await f.manager()).run('paper-active-postmarket',produce,options)
    const prepare=f.env.OPS_DB.prepare.bind(f.env.OPS_DB)
    f.env.OPS_DB.prepare=(sql:string)=>{
      const statement=prepare(sql)
      if(sql.includes('FROM paper_challenger_candidates'))statement.all=async()=>({success:false,results:[]})
      return statement
    }
    await assert.rejects((await f.manager()).run('paper-active-postmarket',produce,options),/readback_failed/)
    assert.equal(requests,1)
    assert.equal((f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any).state,'post_verify_task_v1:success')
    f.env.OPS_DB.prepare=prepare
    f.sqlite.exec("DELETE FROM paper_challenger_daily_metrics")
    const observed=await (await f.manager()).run('paper-active-postmarket',produce,options)
    assert.equal(observed.status,'error');assert.equal(observed.critical,false)
    assert.equal(requests,1)
  }finally{globalThis.fetch=previous;f.sqlite.close()}
})

test('Paper fresh proof handles 120 candidates with bounded D1 parameter pages',async()=>{
  const f=fixture(),previous=globalThis.fetch
  const ddl=readFileSync('domain-schemas/paper.sql','utf8')
  for(const table of ['paper_challenger_candidates','paper_challenger_daily_metrics','promotion_audit_events'])
    f.sqlite.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0])
  const report={generated_at:date+'T21:00:00Z',candidate_count:120,evaluated_count:120,real_trading_effect:'none',audit_events:[],
    promotion_packets:Array.from({length:120},(_,i)=>({candidate_id:`candidate-${i.toString().padStart(3,'0')}`,candidate_type:'fixture',
      current_state:'paper_active_challenger',decision:'hold',challenger_metrics:{paper_decision_count:4,hit_rate:0.5}}))}
  globalThis.fetch=async()=>Response.json(report)
  let maxReadBindings=0
  const prepare=f.env.OPS_DB.prepare.bind(f.env.OPS_DB)
  f.env.OPS_DB.prepare=(sql:string)=>{
    const statement=prepare(sql),bind=statement.bind.bind(statement)
    statement.bind=(...args:any[])=>{if(sql.includes(' IN ('))maxReadBindings=Math.max(maxReadBindings,args.length);return bind(...args)}
    return statement
  }
  try{
    await (await f.manager()).run('paper-active-postmarket',async env=>{
      const response=await controllerFetch(env,'/paper_challenger/postmarket_report',{method:'POST',jsonBody:{run_date:date}})
      await recordPaperActivePostmarketReport(env,await response.json())
      const result=success('paper-active-postmarket')
      return {...result,evidence:await capturePostVerifyOwnerEvidence(env,'paper-active-postmarket',date,result)}
    })
    assert.ok(maxReadBindings<=65)
    const result=JSON.parse((f.sqlite.prepare('SELECT receipt_json FROM post_verify_task_receipts_v1').get() as any).receipt_json).result
    assert.equal(result.evidence.paper.candidateCount,120)
    assert.equal(await verifyPostVerifyOwnerEvidence(f.env,'paper-active-postmarket',date,result),true)
  }finally{globalThis.fetch=previous;f.sqlite.close()}
})

test('Obsidian operation proof requires exact date, actual paths and both owner GitHub acknowledgements',async()=>{
  const f=fixture(),previous=globalThis.fetch
  const paths=[`Daily/${date}.md`,`Pipeline/${date}.md`]
  globalThis.fetch=async()=>Response.json({status:'ok',date,files_generated:2,vault_pushed:true,progress_synced:true,details:paths})
  try{
    await (await f.manager()).run('obsidian-sync',async env=>{
      await controllerFetch(env,'/obsidian/daily',{method:'POST',jsonBody:{date}})
      const result=success('obsidian-sync')
      return {...result,evidence:await capturePostVerifyOwnerEvidence(env,'obsidian-sync',date,result)}
    })
    const row=f.sqlite.prepare('SELECT receipt_json FROM post_verify_task_receipts_v1').get() as any
    const result=JSON.parse(row.receipt_json).result
    assert.deepEqual(result.evidence.acks.owners[0].owner.paths,paths)
    assert.equal(await verifyPostVerifyOwnerEvidence(f.env,'obsidian-sync',date,result),true)
  }finally{globalThis.fetch=previous;f.sqlite.close()}
})

test('unrecordable result closes its claim as ERROR before failing instead of leaving it running',async()=>{
  const f=fixture(), manager=await f.manager()
  await assert.rejects(manager.run('huge',async()=>({...success('huge'),evidence:{blob:'x'.repeat(40_000)}}),{retrySafe:true}),/receipt_too_large/)
  const row=f.sqlite.prepare('SELECT state,receipt_json FROM post_verify_task_receipts_v1').get() as any
  assert.equal(row.state,'post_verify_task_v1:error')
  assert.match(JSON.parse(row.receipt_json).result.summary,/receipt_too_large:huge; original_status=success/)
  await assert.rejects(manager.run('bigint',async()=>({...success('bigint'),evidence:{n:1n}})),/BigInt/)
  await assert.rejects(manager.run('thrown',async()=>{throw new Error('y'.repeat(40_000))}),/receipt_too_large/)
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) n FROM post_verify_task_receipts_v1 WHERE state='post_verify_task_v1:running'").get() as any).n,0)
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) n FROM post_verify_task_receipts_v1 WHERE state='post_verify_task_v1:error'").get() as any).n,3)
  // The date is not blocked: the idempotent task runs again under the same lease.
  assert.equal((await (await f.manager()).run('huge',async()=>success('huge'),{retrySafe:true})).status,'success')
  f.sqlite.close()
})

const takeover=async(f:ReturnType<typeof fixture>,owner:string)=>{
  f.sqlite.prepare("UPDATE pipeline_stage_runs SET lease_expires_at='2000-01-01 00:00:00'").run()
  assert.ok(await claimPipelineStage(f.env.OPS_DB,{businessDate:date,stage:'post_verify_chain',canonicalRunId:run,ownerId:owner}))
  return createPostVerifyTaskCheckpoints(f.env,{businessDate:date,canonicalRunId:run,leaseOwner:owner,productionEligible:true,assertStageLease:async()=>{}})
}

test('expired stage lease reclaims an idempotent running receipt; the stale producer stays fenced',async()=>{
  const f=fixture();let calls=0
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  await assert.rejects((await f.manager()).run('projection',async env=>{
    calls++;await gate
    await env.DB.prepare("INSERT INTO writes VALUES(1,'stale')").run()
    return success('projection')
  },{retrySafe:true,timeoutMs:2}),/timeout_unsettled/)
  // Same live lease: the claim may still be in flight, so nothing is reclaimed.
  await assert.rejects((await f.manager()).run('projection',async()=>{calls++;return success('projection')},{retrySafe:true}),/unsettled_side_effect/)
  assert.equal(calls,1)
  const next=await takeover(f,'lease-B')
  const result=await next.run('projection',async env=>{
    calls++;await env.DB.prepare("INSERT INTO writes VALUES(2,'fresh')").run();return success('projection')
  },{retrySafe:true})
  assert.equal(result.status,'success');assert.equal(calls,2)
  release()
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.deepEqual(f.sqlite.prepare('SELECT id FROM writes').all().map((row:any)=>row.id),[2])
  assert.equal((f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any).state,'post_verify_task_v1:success')
  f.sqlite.close()
})

test('unexpired stage lease cannot be taken over, so its running receipt is never reclaimed',async()=>{
  const f=fixture();let calls=0
  await assert.rejects((await f.manager()).run('projection',async()=>{calls++;return new Promise<PostVerifyTaskResult>(()=>{})},
    {retrySafe:true,timeoutMs:2}),/timeout_unsettled/)
  assert.equal(await claimPipelineStage(f.env.OPS_DB,{businessDate:date,stage:'post_verify_chain',canonicalRunId:run,ownerId:'lease-B'}),null)
  const other=await createPostVerifyTaskCheckpoints(f.env,{businessDate:date,canonicalRunId:run,leaseOwner:'lease-B',productionEligible:true,assertStageLease:async()=>{}})
  await assert.rejects(other.run('projection',async()=>{calls++;return success('projection')},{retrySafe:true}),/authority_lost/)
  assert.equal(calls,1)
  assert.equal((f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any).state,'post_verify_task_v1:running')
  f.sqlite.close()
})

test('expired lease keeps a non-idempotent running receipt blocked and names it',async()=>{
  const f=fixture();let calls=0
  await assert.rejects((await f.manager()).run('promotion',async()=>{calls++;return new Promise<PostVerifyTaskResult>(()=>{})},{timeoutMs:2}),/timeout_unsettled/)
  const next=await takeover(f,'lease-B')
  await assert.rejects(next.run('promotion',async()=>{calls++;return success('promotion')}),/unsettled_side_effect:promotion:expired_lease_requires_reconciliation:promotion/)
  await assert.rejects(next.run('projection',async()=>{calls++;return success('projection')},{retrySafe:true}),/expired_lease_requires_reconciliation:promotion/)
  assert.equal(calls,1)
  assert.equal((f.sqlite.prepare('SELECT state FROM post_verify_task_receipts_v1').get() as any).state,'post_verify_task_v1:running')
  f.sqlite.close()
})

test('legacy running receipt from an older revision is reclaimed by the same idempotent task under a new lease',async()=>{
  const f=fixture();let calls=0
  await assert.rejects((await f.manager()).run(tasks[0],async()=>{calls++;return new Promise<PostVerifyTaskResult>(()=>{})},
    {retrySafe:true,timeoutMs:2}),/timeout_unsettled/)
  // Receipts claimed before this change carry no retrySafe flag.
  f.sqlite.prepare("UPDATE post_verify_task_receipts_v1 SET receipt_json=json_remove(receipt_json,'$.retrySafe')").run()
  const stale=f.sqlite.prepare('SELECT receipt_key FROM post_verify_task_receipts_v1').get() as any
  f.env.CF_VERSION_METADATA={tag:'d'.repeat(40),id:'version-D',timestamp:'now'}
  const next=await takeover(f,'lease-B')
  await assert.rejects(next.run(tasks[1],async()=>{calls++;return success(tasks[1])},{retrySafe:true}),/expired_lease_requires_reconciliation/)
  assert.equal((await next.run(tasks[0],async()=>{calls++;return success(tasks[0])},{retrySafe:true})).status,'success')
  assert.equal(calls,2)
  const closed=f.sqlite.prepare('SELECT state,receipt_json FROM post_verify_task_receipts_v1 WHERE receipt_key=?').get(stale.receipt_key) as any
  assert.equal(closed.state,'post_verify_task_v1:error')
  assert.match(JSON.parse(closed.receipt_json).result.summary,/lease_expired_reclaimed/)
  // The closed receipt keeps a valid checksum for its own identity.
  f.env.CF_VERSION_METADATA={tag:source,id:'version-A',timestamp:'now'}
  const own=await createPostVerifyTaskCheckpoints(f.env,{businessDate:date,canonicalRunId:run,leaseOwner:'lease-B',productionEligible:true,assertStageLease:async()=>{}})
  assert.equal((await own.run(tasks[0],async()=>{calls++;return success(tasks[0])},{retrySafe:true})).status,'success')
  assert.equal(calls,3)
  f.sqlite.close()
})
