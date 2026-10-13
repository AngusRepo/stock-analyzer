import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { acceptPipelineL3Seal, acceptEveningRootL3Wait } from './pipelineL3SealAcceptance'

async function seedEveningRoot(db: any, day: string) {
  const migration=readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql','utf8')
  for (const sql of migration.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean)) {
    await db.prepare(sql).run()
  }
  await db.prepare(`INSERT INTO scheduler_execution_tickets_v1
    (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,run_id,attempt_id,
      ticket_kind,status,status_authority,payload_checksum,last_error,last_summary,completed_at)
    VALUES('root','root','root','evening-chain','evening-chain',?,'root-run','attempt',
      'physical_root','error','logical_child','checksum',
      'pipeline_execution:error,post_pipeline_chain:missing','previous pipeline failed','2026-10-07 10:00:00')`)
    .bind(day).run()
  for (const stage of ['finlab_market','finlab_sequence','screener_v2','post_screener_continuation']) {
    await db.prepare(`INSERT INTO pipeline_stage_runs VALUES(?,?,'upstream','success',NULL,NULL)`)
      .bind(day,stage).run()
  }
}

test('L3 seal supersedes only same-run release-drift false failure; other terminal and stale runs stay fenced', async () => {
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("isolated") } }', d1Databases: ['OPS'] })
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`CREATE TABLE pipeline_stage_runs (business_date TEXT,stage TEXT,canonical_run_id TEXT,
      status TEXT,last_error TEXT,updated_at TEXT,PRIMARY KEY(business_date,stage))`).run()
    const day = '2026-10-07', run = 'pipeline:current'
    for (const [status, error, accepted] of [
      ['running', null, true], ['waiting', null, true],
      ['error', 'pipeline_modal_recovery_source_changed', true],
      ['error', 'model_artifact_checksum_mismatch', false],
      ['error', null, false], ['success', null, false],
    ] as const) {
      await db.prepare(`INSERT OR REPLACE INTO pipeline_stage_runs VALUES(?,'pipeline_execution',?,?,?,NULL)`)
        .bind(day,run,status,error).run()
      assert.equal(await acceptPipelineL3Seal(db as any,day,'pipeline:old'), false)
      assert.equal(await acceptPipelineL3Seal(db as any,'2026-10-06',run), false)
      assert.equal(await acceptPipelineL3Seal(db as any,day,run), accepted)
      const row = await db.prepare('SELECT status,last_error FROM pipeline_stage_runs').first()
      assert.deepEqual(row, accepted ? {status:'waiting',last_error:'awaiting_premarket'} : {status,last_error:error})
      if (accepted) assert.equal(await acceptPipelineL3Seal(db as any,day,run), true)
    }
  } finally { await mf.dispose() }
})


test('authenticated L3 callback repairs canonical and KV together; stale or malformed receipt cannot', async () => {
  const { adminControlRoutes } = await import('../routes/adminControlRoutes')
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("isolated") } }',
    d1Databases: ['OPS'], kvNamespaces: ['KV'] })
  try {
    const db = await mf.getD1Database('OPS'), kv = await mf.getKVNamespace('KV') as unknown as KVNamespace
    await db.prepare(`CREATE TABLE pipeline_stage_runs (business_date TEXT,stage TEXT,canonical_run_id TEXT,
      status TEXT,last_error TEXT,updated_at TEXT,PRIMARY KEY(business_date,stage))`).run()
    const day='2026-10-07', run='pipeline:current'
    await seedEveningRoot(db,day)
    await db.prepare(`INSERT INTO pipeline_stage_runs VALUES(?,'pipeline_execution',?,'error',
      'pipeline_modal_recovery_source_changed',NULL)`).bind(day,run).run()
    await kv.put('scheduler:run:pipeline:'+day,JSON.stringify({task:'pipeline',status:'error',
      summary:'pipeline_modal_recovery_source_changed',run_id:run,run_date:day}))
    const env={DB:db,OPS_DB:db,KV:kv,MULTI_D1_ACTIVE_DOMAINS:'ops',MULTI_D1_STRICT:'true',
      STOCKVISION_AUTH_TOKEN:'isolated-l3-token',PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any
    const seal={run_date:day,run_id:run,schema_version:'premarket-l3-seal-v1',checksum:'a'.repeat(64)}
    const post=(receipt=seal, callbackRun=run, auth='isolated-l3-token') => adminControlRoutes.request(
      'https://local.test/api/admin/scheduler-callback',{method:'POST',
        headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({
          task:'pipeline',status:'triggered',run_date:day,run_id:callbackRun,l3_receipt:receipt,
          summary:'awaiting_premarket l3_sealed=true cloud_compute_stopped=true'})},env)
    assert.equal((await post(seal,run,'wrong')).status,401)
    assert.equal((await post({...seal,checksum:'bad'})).status,400)
    assert.equal((await post({...seal,run_id:'pipeline:old'},'pipeline:old')).status,409)
    assert.equal((await db.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='pipeline_execution'").first())?.status,'error')
    assert.equal((await post()).status,200)
    assert.deepEqual(await db.prepare("SELECT status,last_error FROM pipeline_stage_runs WHERE stage='pipeline_execution'").first(),
      {status:'waiting',last_error:'awaiting_premarket'})
    const log=await kv.get('scheduler:run:pipeline:'+day,'json') as any
    assert.equal(log.status,'triggered')
    assert.match(log.summary,/l3_sealed=true/)
    assert.equal(log.run_id,run)
    assert.equal((await post()).status,200)
    const root=await db.prepare("SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id='root'").first() as any
    assert.equal(root.status,'triggered')
    assert.equal(root.last_error,null)
    assert.equal(root.completed_at,null)
    assert.equal(root.run_id,'root-run')
    assert.equal(JSON.parse(root.metadata_json).l3_previous_summary,'previous pipeline failed')
    assert.equal(JSON.parse(root.metadata_json).l3_checksum,seal.checksum)
    const rootLog=await kv.get('scheduler:run:evening-chain:'+day,'json') as any
    assert.equal(rootLog.status,'triggered')
    assert.equal(rootLog.run_id,run)
    assert.match(rootLog.summary,/awaiting_premarket/)
  } finally {await mf.dispose()}
})

test('L3 root recovery fences stale runs, missing upstream, unrelated failures and terminal success',async()=>{
  const mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("test")} }',d1Databases:['OPS']})
  try {
    const db=await mf.getD1Database('OPS'),day='2026-10-07',run='pipeline:current'
    await db.prepare(`CREATE TABLE pipeline_stage_runs (business_date TEXT,stage TEXT,canonical_run_id TEXT,
      status TEXT,last_error TEXT,updated_at TEXT,PRIMARY KEY(business_date,stage))`).run()
    await seedEveningRoot(db,day)
    await db.prepare(`INSERT INTO pipeline_stage_runs VALUES(?,'pipeline_execution',?,'waiting','awaiting_premarket',NULL)`).bind(day,run).run()
    const accept=(id=run)=>acceptEveningRootL3Wait(db as any,day,id,'a'.repeat(64))
    assert.equal(await accept('old'),false)
    await db.prepare("UPDATE pipeline_stage_runs SET status='error' WHERE stage='screener_v2'").run()
    assert.equal(await accept(),false)
    await db.prepare("UPDATE pipeline_stage_runs SET status='success' WHERE stage='screener_v2'").run()
    for(const [status,error] of [['error','finlab:checksum_mismatch'],['error','pipeline_execution:error,verify_v2:error'],['error','pipeline_execution:error,unknown:"broken'],['blocked','pipeline_execution:error'],['success',null],['skipped',null]]) {
      await db.prepare("UPDATE scheduler_execution_tickets_v1 SET status=?,last_error=? WHERE ticket_id='root'").bind(status,error).run()
      assert.equal(await accept(),false)
    }
    await db.prepare("UPDATE scheduler_execution_tickets_v1 SET status='error',last_error='pipeline_execution:error,verify_v2:missing' WHERE ticket_id='root'").run()
    await db.prepare(`INSERT INTO pipeline_stage_runs VALUES(?,'verify_v2',?,'error','verify failed',NULL)`).bind(day,run).run()
    assert.equal(await accept(),false)
    await db.prepare("DELETE FROM pipeline_stage_runs WHERE stage='verify_v2'").run()
    assert.equal(await accept(),true)
    assert.equal(await accept(),true)
  } finally {await mf.dispose()}
})
