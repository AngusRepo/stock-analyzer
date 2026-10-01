import type { Bindings, UpdateQueueMsg } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { claimPipelineStage, markPipelineStageFenced, startPipelineStageLeaseHeartbeat } from './pipelineStageLease'

type Stage = 'finlab_market' | 'finlab_sequence'
const stages: Stage[] = ['finlab_market', 'finlab_sequence']
const canonical = (date: string) => `${date}:finlab-completion-v1`

function insertStage(db: D1Database, date: string, stage: Stage, runId: string, force: boolean) {
  return db.prepare(`INSERT INTO pipeline_stage_runs
    (business_date,stage,canonical_run_id,status,cursor_key,queued_at,updated_at)
    VALUES (?,?,?,'queued',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(business_date,stage) DO UPDATE SET status='queued',cursor_key=excluded.cursor_key,
      attempt_count=0,lease_owner=NULL,lease_expires_at=NULL,started_at=NULL,completed_at=NULL,last_error=NULL,
      queued_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE ?=1 AND json_extract(pipeline_stage_runs.cursor_key,'$.runId')<>?
      AND pipeline_stage_runs.status IN ('success','error','waiting')`)
    .bind(date,stage,canonical(date),JSON.stringify({runId,force}),force?1:0,runId)
}

/** Durable same-day outbox: duplicate callbacks cannot reset an existing stage. */
export async function queueFinLabCompletion(env: Bindings, date: string, runId: string, force = false, includeMarket = true) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !runId) throw new Error('finlab_completion_identity_missing')
  const db = databaseForDataDomain(env, 'ops')
  await db.batch((includeMarket ? stages : ['finlab_sequence'] as Stage[])
    .map(stage => insertStage(db,date,stage,runId,force)))
  await dispatchFinLabCompletion(env, date)
}

export async function dispatchFinLabCompletion(env: Bindings, date: string, delaySeconds = 0) {
  const db = databaseForDataDomain(env, 'ops')
  await db.prepare(`UPDATE pipeline_stage_runs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
    queued_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND canonical_run_id=? AND stage IN ('finlab_market','finlab_sequence')
    AND attempt_count<3 AND (status IN ('error','waiting') OR (status='running' AND lease_expires_at<CURRENT_TIMESTAMP))`)
    .bind(date,canonical(date)).run()
  const { results } = await db.prepare(`SELECT stage,cursor_key FROM pipeline_stage_runs
    WHERE business_date=? AND canonical_run_id=? AND stage IN ('finlab_market','finlab_sequence') AND status='queued' AND attempt_count<3`)
    .bind(date,canonical(date)).all<{stage:Stage;cursor_key:string}>()
  for (const row of results) {
    const meta = JSON.parse(row.cursor_key)
    await env.UPDATE_QUEUE.send({type:row.stage==='finlab_market'?'finlab_backfill_complete':'finlab_sequence_refresh',
      triggerTime:date,runId:meta.runId,force:meta.force,cursor:0,attempt:1}, {delaySeconds})
  }
  return results.length
}

/** One active consumer, short renewable lease, stale owners cannot close it. */
export async function runFinLabCompletionStage(
  env: Bindings, msg: UpdateQueueMsg, stage: Stage,
  work: (guard: (phase?: string) => Promise<void>) => Promise<string>,
): Promise<string> {
  const date = msg.triggerTime, db = databaseForDataDomain(env,'ops'), runId = canonical(date)
  // Also accepts already queued legacy messages at the release boundary.
  await insertStage(db,date,stage,msg.runId??`finlab-market:${date}`,false).run()
  const row = await db.prepare('SELECT status,attempt_count,cursor_key FROM pipeline_stage_runs WHERE business_date=? AND stage=?')
    .bind(date,stage).first<{status:string;attempt_count:number;cursor_key:string}>()
  if (row?.cursor_key && JSON.parse(row.cursor_key).runId !== (msg.runId??`finlab-market:${date}`))
    return `status=pending finlab_stage=${stage} superseded_delivery`
  if (row?.status==='success') return `status=success finlab_stage=${stage} already_complete`
  if ((row?.attempt_count??0)>=3) throw new Error(`finlab_completion_retry_exhausted:${stage}`)
  const leaseOwner = `${runId}:${stage}:${crypto.randomUUID()}`
  const claimed = await claimPipelineStage(db,{businessDate:date,stage,canonicalRunId:runId,ownerId:leaseOwner,leaseSeconds:300})
  if (!claimed) return `status=pending finlab_stage=${stage} state=${row?.status??'busy'}`
  const identity = {businessDate:date,stage,canonicalRunId:runId,leaseOwner}
  // A force producer may have replaced an error row between read and claim.
  if (JSON.parse(claimed.cursor_key!).runId !== (msg.runId??`finlab-market:${date}`)) {
    await markPipelineStageFenced(db,{...identity,status:'waiting'})
    await dispatchFinLabCompletion(env,date)
    return `status=pending finlab_stage=${stage} superseded_delivery`
  }
  const heartbeat = startPipelineStageLeaseHeartbeat(db,{...identity,leaseSeconds:300})
  try {
    await heartbeat.assertActive('before_work')
    const result = await work(heartbeat.assertActive)
    await heartbeat.assertActive('before_complete')
    const waiting = result.startsWith('source waiting;')
    if (!await markPipelineStageFenced(db,{...identity,status:waiting?'waiting':'success'})) throw new Error('finlab_completion_stale_owner')
    if (waiting) await db.prepare(`UPDATE pipeline_stage_runs SET attempt_count=MAX(0,attempt_count-1)
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND status='waiting' AND lease_owner IS NULL`)
      .bind(date,stage,runId).run()
    if (waiting) await dispatchFinLabCompletion(env,date,120)
    return result
  } catch(error) {
    if (!heartbeat.leaseError()) {
      const closed = await markPipelineStageFenced(db,{...identity,status:'error',error:String(error)})
      if (closed) await dispatchFinLabCompletion(env,date,120).catch(() => {})
    }
    throw error
  } finally { await heartbeat.stop() }
}
