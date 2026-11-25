import type { Bindings, UpdateQueueMsg } from '../types'
import { databaseForDataDomain, databaseForTable } from './dataDomainRegistry'
import { logSchedulerResult } from './schedulerRunLogger'
import { resolveTwTradingSession } from './schedulerPolicy'
import { recordedClosure } from './twRecordedClosure'
import { settlePremarketReadinessTickets } from './premarketReadinessTickets'
import { premarketPublicationCutoff, premarketPublicationMinutes, premarketPublicationTarget } from './premarketPublicationWindow'
import { paperAccountId } from './paperExecutionScope'
import { recordChainStage } from './opsChainStageState'

export type PremarketStage = 'context' | 'setup' | 'allocate' | 'market-health' | `debate:${number}` | `replan:${number}` | `publish:${number}`
export interface PremarketPayload { [key: string]: unknown }
export interface PremarketResult { next: PremarketStage | null; followups?: PremarketStage[]; receipt: PremarketPayload }
export type PremarketWork = (stage: PremarketStage, input: PremarketPayload, guard: () => Promise<void>) => Promise<PremarketResult>
const PREFIX = 'premarket_v3:'
const RUN = (date: string) => `${date}:premarket-v3`
const MAX_ATTEMPTS = 3
function october21PublicationRecovery(env: Bindings, date: string): boolean {
  return date === '2026-10-21' && env.PAPER_DAILY_PLAN_OWNER === 'premarket_once_v1'
    && env.LIVE_EXECUTION_CLIENT_ENABLED === '0' && env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED === '0'
}
const october21AllocationRetryPredicate = `target.business_date='2026-10-21'
  AND target.canonical_run_id='2026-10-21:premarket-v3' AND target.stage='premarket_v3:allocate'
  AND target.attempt_count=3 AND target.last_error='Error: paper_morning_recovery_setup_not_materialized'
  AND json_extract(target.cursor_key,'$.signal_date')='2026-10-20'
  AND json_extract(target.cursor_key,'$.morning_context.trade_date')='2026-10-21'
  AND json_extract(target.cursor_key,'$.morning_context.checksum')='d5b866e6f694a4b461e02cb54ee058f1ba7bc63e9b04fd5504c15be95b0e7213'
  AND json_extract(target.cursor_key,'$.l3_receipt.run_id')='pipeline-dispatch:2026-10-20:270320c4-8d25-4187-aec2-79595289d428'
  AND json_extract(target.cursor_key,'$.l3_receipt.checksum')='9e36664032344abc96ebfa0ffa39dcc95c59516aad06a5ec5f41423a6efc01f8'`
function october16PublicationRecovery(env: Bindings, date: string): boolean {
  return date === '2026-10-16' && env.PAPER_DAILY_PLAN_OWNER === 'premarket_once_v1'
    && env.LIVE_EXECUTION_CLIENT_ENABLED === '0' && env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED === '0'
}
const historicalAllocationRetryPredicate = `target.business_date='2026-10-16'
  AND target.canonical_run_id='2026-10-16:premarket-v3' AND target.stage='premarket_v3:allocate'
  AND target.attempt_count=3 AND instr(target.last_error,'/pipeline/v2/premarket-resume HTTP 500')>0
  AND json_extract(target.cursor_key,'$.signal_date')='2026-10-15'
  AND json_extract(target.cursor_key,'$.morning_context.trade_date')='2026-10-16'
  AND EXISTS(SELECT 1 FROM pipeline_stage_runs upstream WHERE upstream.business_date='2026-10-15'
    AND upstream.stage='pipeline_execution' AND upstream.status='error'
    AND upstream.canonical_run_id=json_extract(target.cursor_key,'$.l3_receipt.run_id')
    AND upstream.last_error='paired_nav:atomic_collection:historical_not_prospective; paired_nav:atomic_daily:requires_allocation_and_native_execution; paired_nav:atomic_candidate_setup:paired_nav_atomic_no_executable_plans')`
const reconciledPublicationRetryPredicate = `target.business_date='2026-10-16'
  AND target.canonical_run_id='2026-10-16:premarket-v3' AND target.stage='premarket_v3:allocate'
  AND target.attempt_count=4 AND target.last_error='Error: paper_morning_recovery_setup_not_materialized'
  AND json_extract(target.cursor_key,'$.signal_date')='2026-10-15'
  AND json_extract(target.cursor_key,'$.morning_context.trade_date')='2026-10-16'
  AND EXISTS(SELECT 1 FROM pipeline_stage_runs upstream WHERE upstream.business_date='2026-10-15'
    AND upstream.stage='pipeline_execution' AND upstream.status='success'
    AND upstream.canonical_run_id=json_extract(target.cursor_key,'$.l3_receipt.run_id'))`
export const PREMARKET_READY_TARGET = '08:45'
function validStage(stage: string): stage is PremarketStage {
  return /^(context|setup|allocate|market-health|(debate|replan|publish):[0-2])$/.test(stage)
}
export function premarketClock(now = Date.now()) {
  const tw = new Date(now + 8 * 3600_000)
  return { date: tw.toISOString().slice(0, 10), minutes: tw.getUTCHours() * 60 + tw.getUTCMinutes() }
}
export function premarketStageNotBefore(date: string, stage: PremarketStage): number {
  return Date.parse(`${date}T${stage === 'context' ? '06:45' : stage === 'market-health' ? '08:30' : '07:15'}:00+08:00`)
}
interface Row { stage: string; status: string; cursor_key: string | null; attempt_count: number; lease_owner: string | null }
type ChainRow = Pick<Row,'stage'|'status'|'cursor_key'> & { last_error: string | null }
const EXPIRED = 'premarket_session_expired'
/** Waits on an unavailable controller back off (120s doubling, capped); dependency waits keep the 120s cadence. */
const BACKOFF_WAIT = /premarket_wait:controller_unavailable:/
const backoffSeconds = (streak: number) => Math.min(600, 120 * 2 ** Math.max(0, streak - 1))
function backoffStreak(lastError: string | null): number {
  return BACKOFF_WAIT.test(lastError ?? '') ? Number(/backoff_streak=(\d+)/.exec(lastError ?? '')?.[1] ?? 0) : 0
}

/** Bounded, credential-free cause text for a user-visible record. */
export function premarketCauseText(raw: string | null | undefined, max = 300): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
    .replace(/\b(bearer|token|secret|password|api[_-]?key|authorization|x-controller-token)(\s*[=:]\s*|\s+)(?:bearer\s+)?[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/([?&][^=\s&]+=)[^\s&]+/g, '$1[redacted]')
  return (text || 'unknown').slice(0, max)
}
function isReadyRow(r: Pick<Row,'stage'|'status'|'cursor_key'>): boolean {
  return r.stage.startsWith(PREFIX + 'publish:') && r.status === 'success' && JSON.parse(r.cursor_key ?? '{}').output?.ready === true
}
/** The stage that kept the plan from publishing: market health is reported separately and never names the blocker. */
function blockingStage(rows: ChainRow[]): ChainRow | undefined {
  const critical = rows.filter(r => r.stage !== PREFIX + 'market-health')
  return critical.find(r => r.status === 'error') ?? critical.find(r => r.status !== 'success')
    ?? rows.find(r => r.status === 'error') ?? rows.find(r => r.status !== 'success')
}
async function readChain(env: Bindings, date: string): Promise<ChainRow[]> {
  return (await databaseForDataDomain(env, 'ops').prepare(`SELECT stage,status,cursor_key,last_error FROM pipeline_stage_runs
    WHERE business_date=? AND canonical_run_id=? AND stage LIKE 'premarket_v3:%' ORDER BY created_at,stage`)
    .bind(date, RUN(date)).all<ChainRow>()).results
}

/** Display only. In single-plan mode trading acts only on today's finalized daily-plan head, so a
 * ready/empty/halted run without one past the publication target is not executable: returns
 * `premarket_publication_expired:<blocking stage cause>`, else null. Reads D1/KV only; never writes or fetches. */
export async function premarketUnpublishedRunReason(env: Bindings, date: string, now = Date.now()): Promise<string | null> {
  if (env.PAPER_DAILY_PLAN_OWNER !== 'premarket_once_v1' || now < premarketPublicationCutoff(date)) return null
  // Same head-and-review join readL4ExecutionPlan uses before trading acts on the day.
  const head = await databaseForDataDomain(env, 'paper').prepare(`SELECT 1 AS ok FROM paper_daily_plan_heads_v1 h
    JOIN paper_daily_plan_reviews_v1 r ON r.account_id=h.account_id AND r.trade_date=h.trade_date AND r.checksum=h.checksum
    WHERE h.account_id=? AND h.trade_date=?`).bind(paperAccountId(), date).first()
  if (head) return null
  // A closure announced after the run was written stops the day; it is not a failed publication.
  if (await recordedClosure(env.KV, date)) return null
  const blocker = blockingStage(await readChain(env, date))
  const cause = blocker ? `${blocker.stage.slice(PREFIX.length)}:${blocker.last_error ?? blocker.status}` : 'not_started'
  return 'premarket_publication_expired:' + premarketCauseText(cause)
}
/** Display projection of today's run meta: an unpublished decision shows as a failed flow with
 * its reason (original status kept). An unverifiable check leaves the meta as it is, marked. */
export async function premarketPublicationDisplayMeta<M extends Record<string, any>>(
  env: Bindings, date: string, meta: M | null | undefined, now = Date.now(),
): Promise<M | null | undefined> {
  if (!meta || !['ready', 'empty', 'halted'].includes(String(meta.status))) return meta
  let reason: string | null
  try { reason = await premarketUnpublishedRunReason(env, date, now) } catch (error) {
    console.warn('[premarket] publication display check unavailable:', premarketCauseText(String(error), 200))
    return { ...meta, publication_check: 'unavailable' }
  }
  return reason ? { ...meta, status: 'error', error_message: reason, original_status: meta.status,
    original_error_message: meta.error_message, publication_state: 'expired' } : meta
}
/** The same projection for today's entry in the run history. */
export function projectExpiredRunHistory<H>(history: H, runId: unknown, displayMeta: Record<string, any> | null | undefined): H {
  const runs = (history as { runs?: unknown })?.runs
  if (displayMeta?.publication_state !== 'expired' || !Array.isArray(runs)) return history
  return { ...history, runs: runs.map((run: Record<string, any>) => run.run_id === Number(runId)
    ? { ...run, status: 'error', error_message: displayMeta.error_message, original_status: run.status } : run) }
}

/** A trading day whose chain missed its publication target gets one explicit error run, so
 * "no decision today" is visible. An existing decision (any non-superseded run) is never replaced.
 * source_reco_date stays NULL: no recommendation date was consumed, and the data-quality date
 * check fails an error run on its status before it looks at the source date. */
async function recordPremarketNoDecision(env: Bindings, date: string, rows: ChainRow[]): Promise<string> {
  if (rows.some(isReadyRow)) return 'published'
  const blocker = blockingStage(rows)
  const cause = blocker ? `${blocker.stage.slice(PREFIX.length)}:${blocker.last_error ?? blocker.status}` : 'not_started'
  const message = 'premarket_no_decision:' + premarketCauseText(cause)
  const result = await databaseForTable(env, 'pending_buy_runs').prepare(`INSERT INTO pending_buy_runs
    (trade_date,source_reco_date,status,debate_status,candidate_count,error_message,created_at,updated_at)
    SELECT ?,NULL,'error','skipped',0,?,datetime('now'),datetime('now')
    WHERE NOT EXISTS (SELECT 1 FROM pending_buy_runs WHERE trade_date=? AND status!='superseded')`)
    .bind(date, message, date).run()
  return Number(result.meta?.changes ?? 0) > 0 ? 'recorded' : 'existing_decision'
}

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
  const health = rows.find(r => r.stage === PREFIX + 'market-health')
  const failed = rows.find(r => r.status === 'error')
  const common = {run_date:date,run_id:RUN(date),run_scope:'live_canonical' as const,duration_ms:0}
  if (setupDone) await logSchedulerResult(env.KV,'morning-setup',{
    ...common,status:'success',summary:'status=success event_stage=setup; successor stages follow immediately',
  })
  if (published || failed) await logSchedulerResult(env.KV, failed && !setupDone && !published ? 'morning-setup' : 'pre-market-warmup',{
    ...common,status:health?.status === 'error' ? 'error' : published ? 'success' : 'error',
    summary:health?.status === 'error' ? 'status=error event_stage=market-health plan_published=' + Boolean(published) : published ? `status=success event_driven_ready market_health=${health?.status ?? 'not_scheduled'} ${published.cursor_key}` : `status=error event_stage=${failed?.stage}`,
  })
  if (published && health?.status === 'success') {
    await settlePremarketReadinessTickets(databaseForDataDomain(env,'ops'), date)
  }
}

/** Past the publication window nothing is dispatched; an unfinished trading-day chain is reported overdue, never a quiet skip. */
async function premarketOverdueSummary(env: Bindings, date: string): Promise<string> {
  const session = await resolveTwTradingSession(env.KV, date, env)
  if (!session.trading) return 'status=skipped premarket_outside_window'
  const results = await readChain(env, date)
  if (results.some(isReadyRow)) return 'status=skipped premarket_outside_window'
  const stage = results.find(r => r.status === 'error')?.stage ?? results.find(r => r.status !== 'success')?.stage ?? 'not_started'
  // Recording is visibility only: a failed write is reported here, and the next sweep retries it.
  const record = await recordPremarketNoDecision(env, date, results)
    .catch(error => 'failed:' + premarketCauseText(error instanceof Error ? error.message : String(error), 120))
  const blocker = blockingStage(results)
  return `status=error premarket_event_chain overdue=true ready_target=${premarketPublicationTarget(date)} stage=${stage} no_decision_record=${record}`
    + ` cause=${premarketCauseText(blocker?.last_error ?? blocker?.status ?? 'not_started', 200)}`
}

/** All signals converge on one daily root; watchdog never resets successful stages. */
export async function ensurePremarketEventChain(env: Bindings, date: string, now = Date.now()): Promise<string> {
  const clock = premarketClock(now)
  const windowEnd = env.PAPER_DAILY_PLAN_OWNER==='premarket_once_v1'?premarketPublicationMinutes(date):540
  if (date !== clock.date || clock.minutes < 390) return 'status=skipped premarket_outside_window'
  if (clock.minutes >= windowEnd) return premarketOverdueSummary(env, date)
  const session = await resolveTwTradingSession(env.KV, date, env)
  if (!session.trading) return `status=skipped premarket_non_trading_day reason=${session.reason}`
  const db = databaseForDataDomain(env, 'ops')
  // Source repair grants one continuation of the exact preserved setup. It
  // neither resets attempts nor revives unrelated failures or a fourth failure.
  if (october21PublicationRecovery(env,date)) await db.prepare(`UPDATE pipeline_stage_runs AS target
    SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE target.status='error' AND ${october21AllocationRetryPredicate}`).run()
  if (october16PublicationRecovery(env,date)) await db.prepare(`UPDATE pipeline_stage_runs
    SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND canonical_run_id=? AND stage=? AND status='error'
      AND attempt_count=3 AND instr(last_error,'corporate_source_live_preopen_required')>0`)
    .bind(date,RUN(date),PREFIX+'setup').run()
  if (october16PublicationRecovery(env,date)) await db.prepare(`UPDATE pipeline_stage_runs AS target
    SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE target.status='error' AND ${historicalAllocationRetryPredicate}`).run()
  if (october16PublicationRecovery(env,date)) await db.prepare(`UPDATE pipeline_stage_runs AS target
    SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE target.status='error' AND ${reconciledPublicationRetryPredicate}`).run()
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
  const healthFailed = results.some(r => r.stage === PREFIX + 'market-health' && r.status === 'error')
  const status = healthFailed ? 'error' : ready ? 'success' : failed ? 'error' : 'pending'
  return `status=${status} premarket_event_chain queued=${sent} ready_target=${premarketPublicationTarget(date)} overdue=${!ready && clock.minutes >= premarketPublicationMinutes(date)} stage=${ready ? 'complete' : failed?.stage ?? results.find(r => r.status !== 'success')?.stage ?? 'complete'}`
}

export async function processPremarketEvent(env: Bindings, msg: UpdateQueueMsg, work: PremarketWork, now = Date.now()): Promise<void> {
  const stage = String(msg.premarketStage ?? '')
  const date = msg.triggerTime
  if (!validStage(stage) || msg.runId !== RUN(date)) throw new Error('premarket_message_invalid')
  const db = databaseForDataDomain(env, 'ops')
  const key = PREFIX + stage
  // One Wei-authorized recovery after the three preserved preopen-only failures.
  let attemptLimit = (['2026-10-12','2026-10-13'].includes(date) || october16PublicationRecovery(env,date))
    && stage === 'setup' ? MAX_ATTEMPTS + 1 : MAX_ATTEMPTS
  if (october21PublicationRecovery(env,date) && stage==='allocate'
    && await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs target WHERE target.status='queued'
      AND ${october21AllocationRetryPredicate}`).first())attemptLimit=MAX_ATTEMPTS+1
  if (october16PublicationRecovery(env,date) && stage==='allocate'
    && await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs target WHERE target.status='queued'
      AND ${historicalAllocationRetryPredicate}`).first())attemptLimit=MAX_ATTEMPTS+1
  if (october16PublicationRecovery(env,date) && stage==='allocate'
    && await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs target WHERE target.status='queued'
      AND ${reconciledPublicationRetryPredicate}`).first())attemptLimit=MAX_ATTEMPTS+2
  const clock = premarketClock(now)
  const advisoryWindow = env.PAPER_DAILY_PLAN_OWNER==='premarket_once_v1' && stage.startsWith('debate:') && clock.minutes < 960
  if (date !== clock.date || (!advisoryWindow && clock.minutes >= (env.PAPER_DAILY_PLAN_OWNER==='premarket_once_v1'?premarketPublicationMinutes(date):540))) {
    // Expiry keeps the blocking reason it ends: premarket_session_expired:<previous last_error>.
    await db.prepare(`UPDATE pipeline_stage_runs SET status='error',updated_at=CURRENT_TIMESTAMP,
      last_error=CASE WHEN COALESCE(last_error,'')='' THEN '${EXPIRED}'
        WHEN substr(last_error,1,${EXPIRED.length})='${EXPIRED}' THEN last_error
        ELSE substr('${EXPIRED}:'||last_error,1,900) END
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND status!='success'`)
      .bind(date,key,RUN(date)).run()
    if (date === clock.date) {
      try {
        if ((await resolveTwTradingSession(env.KV, date, env)).trading) await recordPremarketNoDecision(env, date, await readChain(env, date))
      } catch (error) {
        // The overdue sweep (08:50 watchdog and warmup) records it again and reports a failed write.
        console.warn('[premarket] no-decision record deferred to overdue sweep:', premarketCauseText(String(error), 200))
      }
    }
    return
  }
  // A closure announced after the chain was queued (typhoon) must stop every stage.
  const session = await resolveTwTradingSession(env.KV, date, env)
  if (!session.trading) {
    await db.prepare(`UPDATE pipeline_stage_runs SET status='error',last_error=?,updated_at=CURRENT_TIMESTAMP
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND status!='success'`)
      .bind(`premarket_non_trading_day:${session.reason}`,date,key,RUN(date)).run()
    return
  }
  if (now < premarketStageNotBefore(date,stage)) { await dispatchPremarketEvents(env,date,now); return }
  const owner = crypto.randomUUID()
  const row = await db.prepare(`UPDATE pipeline_stage_runs SET status='running',lease_owner=?,lease_expires_at=datetime('now','+600 seconds'),
    attempt_count=attempt_count+1,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND stage=? AND canonical_run_id=?
      AND (status='queued' OR (status='waiting' AND lease_expires_at<=CURRENT_TIMESTAMP)) AND attempt_count<?
    RETURNING cursor_key,last_error,attempt_count`).bind(owner,date,key,RUN(date),attemptLimit).first<{cursor_key:string;last_error:string|null;attempt_count?:number}>()
  if (!row) return
  // Chain stage state (observability; never throws): the claimed stage is running. Stamped with the
  // trade date, so the writer maps it back to the evening chain it continues.
  await recordChainStage({ stageId: stage === 'context' || stage === 'setup' ? 'morning-setup' : 'pre-market-warmup',
    businessDate: date, dateKind: 'run_date', status: 'running', runId: RUN(date),
    attempt: Number(row.attempt_count ?? 0) || undefined, summary: `premarket stage=${stage} claimed` })
  const input = JSON.parse(row.cursor_key ?? '{}') as PremarketPayload
  const guard = async () => {
    const active = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND canonical_run_id=? AND lease_owner=? AND status='running' AND lease_expires_at>=CURRENT_TIMESTAMP`)
      .bind(date,key,RUN(date),owner).first()
    if (!active) throw new Error('premarket_stage_lease_lost')
  }
  try {
    const result = await work(stage,input,guard)
    const successors = [...new Set([...(result.next ? [result.next] : []), ...(result.followups ?? [])])]
    if (successors.some(next => !validStage(next))) throw new Error('premarket_successor_invalid')
    await guard()
    const statements = [db.prepare(`UPDATE pipeline_stage_runs SET status='success',cursor_key=?,completed_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP,last_error=NULL WHERE business_date=? AND stage=? AND canonical_run_id=?
      AND lease_owner=? AND status='running' AND lease_expires_at>=CURRENT_TIMESTAMP`)
      .bind(JSON.stringify({input,output:result.receipt}),date,key,RUN(date),owner)]
    for (const next of successors) statements.push(db.prepare(`INSERT INTO pipeline_stage_runs
      (business_date,stage,canonical_run_id,status,cursor_key,queued_at)
      SELECT ?,?,?,'queued',?,CURRENT_TIMESTAMP FROM pipeline_stage_runs
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND status='success' AND lease_owner=?
      ON CONFLICT(business_date,stage) DO NOTHING`)
      .bind(date,PREFIX+next,RUN(date),JSON.stringify(result.receipt),date,key,RUN(date),owner))
    // Completion and its successor intent commit together; a lost queue send is recoverable.
    await db.batch(statements)
    const committed = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND canonical_run_id=? AND status='success' AND lease_owner=?`).bind(date,key,RUN(date),owner).first()
    if (!committed) throw new Error('premarket_stage_lease_lost')
  } catch (error) {
    const waiting = /premarket_wait:|premarket_evidence_wait:|status=pending/.test(String(error))
    const streak = waiting && BACKOFF_WAIT.test(String(error)) ? backoffStreak(row.last_error) + 1 : 0
    // Backoff never skips the last chance before the publication deadline.
    const deadlineMs = env.PAPER_DAILY_PLAN_OWNER==='premarket_once_v1' ? premarketPublicationCutoff(date) : Date.parse(`${date}T09:00:00+08:00`)
    const delay = streak ? Math.min(backoffSeconds(streak), Math.max(30, Math.ceil((deadlineMs - now) / 1000) - 60)) : 120
    await db.prepare(`UPDATE pipeline_stage_runs SET attempt_count=attempt_count-?, status=CASE WHEN attempt_count>=? AND ?=0 THEN 'error' ELSE 'waiting' END,
      last_error=?,lease_expires_at=datetime('now','+'||?||' seconds'),updated_at=CURRENT_TIMESTAMP
      WHERE business_date=? AND stage=? AND canonical_run_id=? AND lease_owner=? AND status='running'`)
      .bind(waiting ? 1 : 0,attemptLimit,waiting ? 1 : 0,((streak ? `backoff_streak=${streak} ` : '')+String(error)).slice(0,900),delay,date,key,RUN(date),owner).run()
    // Retry the incomplete stage directly; the watchdog recovers a lost delayed send.
    const retry = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND canonical_run_id=? AND lease_owner=? AND status='waiting'`).bind(date,key,RUN(date),owner).first()
    if (retry) await env.UPDATE_QUEUE.send(msg, {delaySeconds:delay}).catch(() => {})
    await projectPremarketProgress(env,date).catch(() => {})
    throw error
  }
  await dispatchPremarketEvents(env,date,now)
  const {results} = await db.prepare(`SELECT stage,status,cursor_key,attempt_count,lease_owner FROM pipeline_stage_runs
    WHERE business_date=? AND canonical_run_id=? AND stage LIKE 'premarket_v3:%'`).bind(date,RUN(date)).all<Row>()
  await projectPremarketProgress(env,date,results)
}
