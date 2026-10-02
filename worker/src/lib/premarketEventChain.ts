import type { Bindings, UpdateQueueMsg } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { logSchedulerResult } from './schedulerRunLogger'

export type PremarketStage = 'context' | 'setup' | 'allocate' | `debate:${number}` | `replan:${number}` | `publish:${number}`
export interface PremarketPayload { [key: string]: unknown }
export interface PremarketResult { next: PremarketStage | null; receipt: PremarketPayload }
export type PremarketWork = (stage: PremarketStage, input: PremarketPayload, guard: () => Promise<void>) => Promise<PremarketResult>
const PREFIX = 'premarket_v3:'
const RUN = (date: string) => `${date}:premarket-v3`
const MAX_ATTEMPTS = 3
export const PREMARKET_READY_TARGET = '08:45'
function validStage(stage: string): stage is PremarketStage {
  return /^(context|setup|allocate|(debate|replan|publish):[0-2])$/.test(stage)
}
export function premarketClock(now = Date.now()) {
  const tw = new Date(now + 8 * 3600_000)
  return { date: tw.toISOString().slice(0, 10), minutes: tw.getUTCHours() * 60 + tw.getUTCMinutes() }
}
export function premarketStageNotBefore(date: string, stage: PremarketStage): number {
  return Date.parse(`${date}T${stage === 'context' ? '06:45' : '07:15'}:00+08:00`)
}
interface Row { stage: string; status: string; cursor_key: string | null; attempt_count: number; lease_owner: string | null }

/** Queued stage rows are the durable outbox. Sending may repeat; claiming cannot. */
export async function dispatchPremarketEvents(env: Bindings, date: string, now = Date.now()): Promise<number> {
  const db = databaseForDataDomain(env, 'ops')
  const { results } = await db.prepare(`SELECT stage FROM pipeline_stage_runs WHERE business_date=?
    AND canonical_run_id=? AND stage LIKE 'premarket_v3:%' AND status='queued'`).bind(date, RUN(date)).all<{stage: string}>()
  for (const row of results) {
    const stage = row.stage.slice(PREFIX.length)
    if (!validStage(stage)) throw new Error('premarket_stage_invalid')
    await env.UPDATE_QUEUE.send({ type: 'premarket_stage', cursor: 0, triggerTime: date, runId: RUN(date), premarketStage: stage },
      { delaySeconds: Math.min(43_200, Math.max(0, Math.ceil((premarketStageNotBefore(date, stage) - now) / 1000))) })
  }
  return results.length
}

async function projectPremarketProgress(env: Bindings, date: string, rows?: Row[]) {
  rows ??= (await databaseForDataDomain(env,'ops').prepare(`SELECT stage,status,cursor_key,attempt_count,lease_owner
    FROM pipeline_stage_runs WHERE business_date=? AND canonical_run_id=? AND stage LIKE 'premarket_v3:%'`)
    .bind(date,RUN(date)).all<Row>()).results
  const setupDone = rows.some(r => r.stage === PREFIX + 'setup' && r.status === 'success')
  const published = rows.find(r => r.stage.startsWith(PREFIX + 'publish:') && r.status === 'success'
    && JSON.parse(r.cursor_key ?? '{}').output?.ready === true)
  const failed = rows.find(r => r.status === 'error')
  const common = {run_date:date,run_id:RUN(date),run_scope:'live_canonical' as const,duration_ms:0}
  if (setupDone) await logSchedulerResult(env.KV,'morning-setup',{
    ...common,status:'success',summary:'status=success event_stage=setup; debate/replan/publication follow immediately',
  })
  if (published || failed) await logSchedulerResult(env.KV, failed && !setupDone ? 'morning-setup' : 'pre-market-warmup',{
    ...common,status:failed ? 'error' : 'success',
    summary:failed ? `status=error event_stage=${failed.stage}` : `status=success event_driven_ready ${published?.cursor_key}`,
  })
}

/** All signals converge on one daily root; watchdog never resets successful stages. */
export async function ensurePremarketEventChain(env: Bindings, date: string, now = Date.now()): Promise<string> {
  const clock = premarketClock(now)
  if (date !== clock.date || clock.minutes < 390 || clock.minutes >= (env.PAPER_DAILY_PLAN_OWNER==='premarket_once_v1'?525:540)) return 'status=skipped premarket_outside_window'
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay()
  if (day === 0 || day === 6 || await env.KV.get(`holiday:${date}`)) return 'status=skipped premarket_non_trading_day'
  const db = databaseForDataDomain(env, 'ops')
  await db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key,queued_at)
    VALUES (?,? ,?,'queued','{}',CURRENT_TIMESTAMP) ON CONFLICT(business_date,stage) DO NOTHING`)
    .bind(date, PREFIX + 'context', RUN(date)).run()
  await db.prepare(`UPDATE pipeline_stage_runs SET status=CASE WHEN attempt_count>=? THEN 'error' ELSE 'queued' END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND canonical_run_id=? AND stage LIKE 'premarket_v3:%'
      AND status IN ('running','waiting') AND lease_expires_at<CURRENT_TIMESTAMP`)
    .bind(MAX_ATTEMPTS, date, RUN(date)).run()
  const sent = await dispatchPremarketEvents(env, date, now)
  const { results } = await db.prepare(`SELECT stage,status,cursor_key,attempt_count,lease_owner FROM pipeline_stage_runs
    WHERE business_date=? AND canonical_run_id=? AND stage LIKE 'premarket_v3:%' ORDER BY created_at,stage`)
    .bind(date, RUN(date)).all<Row>()
  await projectPremarketProgress(env,date,results)
  const failed = results.find(r => r.status === 'error')
  const ready = results.some(r => r.stage.startsWith(PREFIX + 'publish:') && r.status === 'success'
    && JSON.parse(r.cursor_key ?? '{}').output?.ready === true)
  const status = failed ? 'error' : ready ? 'success' : 'pending'
  return `status=${status} premarket_event_chain queued=${sent} ready_target=${PREMARKET_READY_TARGET} overdue=${!ready && clock.minutes >= 525} stage=${failed?.stage ?? results.find(r => r.status !== 'success')?.stage ?? 'complete'}`
}

export async function processPremarketEvent(env: Bindings, msg: UpdateQueueMsg, work: PremarketWork, now = Date.now()): Promise<void> {
  const stage = String(msg.premarketStage ?? '')
  const date = msg.triggerTime
  if (!validStage(stage) || msg.runId !== RUN(date)) throw new Error('premarket_message_invalid')
  const db = databaseForDataDomain(env, 'ops')
  const key = PREFIX + stage
  if (date !== premarketClock(now).date || premarketClock(now).minutes >= (env.PAPER_DAILY_PLAN_OWNER==='premarket_once_v1'?525:540)) {
    await db.prepare(`UPDATE pipeline_stage_runs SET status='error',last_error='premarket_session_expired',updated_at=CURRENT_TIMESTAMP
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND status!='success'`)
      .bind(date,key,RUN(date)).run()
    return
  }
  if (now < premarketStageNotBefore(date,stage)) { await dispatchPremarketEvents(env,date,now); return }
  const owner = crypto.randomUUID()
  const row = await db.prepare(`UPDATE pipeline_stage_runs SET status='running',lease_owner=?,lease_expires_at=datetime('now','+600 seconds'),
    attempt_count=attempt_count+1,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND stage=? AND canonical_run_id=?
      AND (status='queued' OR (status='waiting' AND lease_expires_at<=CURRENT_TIMESTAMP)) AND attempt_count<?
    RETURNING cursor_key`).bind(owner,date,key,RUN(date),MAX_ATTEMPTS).first<{cursor_key:string}>()
  if (!row) return
  const input = JSON.parse(row.cursor_key ?? '{}') as PremarketPayload
  const guard = async () => {
    const active = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND canonical_run_id=? AND lease_owner=? AND status='running' AND lease_expires_at>=CURRENT_TIMESTAMP`)
      .bind(date,key,RUN(date),owner).first()
    if (!active) throw new Error('premarket_stage_lease_lost')
  }
  try {
    const result = await work(stage,input,guard)
    if (result.next && !validStage(result.next)) throw new Error('premarket_successor_invalid')
    await guard()
    const statements = [db.prepare(`UPDATE pipeline_stage_runs SET status='success',cursor_key=?,completed_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP,last_error=NULL WHERE business_date=? AND stage=? AND canonical_run_id=?
      AND lease_owner=? AND status='running' AND lease_expires_at>=CURRENT_TIMESTAMP`)
      .bind(JSON.stringify({input,output:result.receipt}),date,key,RUN(date),owner)]
    if (result.next) statements.push(db.prepare(`INSERT INTO pipeline_stage_runs
      (business_date,stage,canonical_run_id,status,cursor_key,queued_at)
      SELECT ?,?,?,'queued',?,CURRENT_TIMESTAMP FROM pipeline_stage_runs
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND status='success' AND lease_owner=?
      ON CONFLICT(business_date,stage) DO NOTHING`)
      .bind(date,PREFIX+result.next,RUN(date),JSON.stringify(result.receipt),date,key,RUN(date),owner))
    // Completion and its successor intent commit together; a lost queue send is recoverable.
    await db.batch(statements)
    const committed = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND canonical_run_id=? AND status='success' AND lease_owner=?`).bind(date,key,RUN(date),owner).first()
    if (!committed) throw new Error('premarket_stage_lease_lost')
  } catch (error) {
    const waiting = /premarket_wait:|premarket_evidence_wait:|status=pending/.test(String(error))
    await db.prepare(`UPDATE pipeline_stage_runs SET attempt_count=attempt_count-?, status=CASE WHEN attempt_count>=? AND ?=0 THEN 'error' ELSE 'waiting' END,
      last_error=?,lease_expires_at=datetime('now','+120 seconds'),updated_at=CURRENT_TIMESTAMP
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND lease_owner=? AND status='running'`)
      .bind(waiting ? 1 : 0,MAX_ATTEMPTS,waiting ? 1 : 0,String(error).slice(0,900),date,key,RUN(date),owner).run()
    // Retry the incomplete stage directly; the watchdog recovers a lost delayed send.
    const retry = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND canonical_run_id=? AND lease_owner=? AND status='waiting'`).bind(date,key,RUN(date),owner).first()
    if (retry) await env.UPDATE_QUEUE.send(msg, {delaySeconds:120}).catch(() => {})
    await projectPremarketProgress(env,date).catch(() => {})
    throw error
  }
  await dispatchPremarketEvents(env,date,now)
  const {results} = await db.prepare(`SELECT stage,status,cursor_key,attempt_count,lease_owner FROM pipeline_stage_runs
    WHERE business_date=? AND canonical_run_id=? AND stage LIKE 'premarket_v3:%'`).bind(date,RUN(date)).all<Row>()
  await projectPremarketProgress(env,date,results)
}
