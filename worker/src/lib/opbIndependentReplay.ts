import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'
import { databaseForDataDomain } from './dataDomainRegistry'
import { writeSystemLog } from './notify'

// The controller only starts a Cloud Run Job execution (l4_opb_replay_dispatch), so the
// call returns in seconds; the replay itself (~2 min solve and a 0.8-2.4 GB snapshot per
// new day) never runs inside the Scheduler delivery. Not trading parameters.
export const OPB_REPLAY_DISPATCH_TIMEOUT_MS = 45_000
// One completed independent replay per business date: watchdog ticks and parked
// continuations re-enter the gate many times a night. Marker only, never evidence.
export const opbIndependentReplayKey = (businessDate: string) => `opb:arm-replay:independent:${businessDate}`
// A started execution; shorter than the 30 min watchdog cadence, so the next tick reads its
// receipt or, if it never wrote one, starts another (the controller refuses while one runs).
export const opbReplayInFlightKey = (businessDate: string) => `opb:arm-replay:dispatched:${businessDate}`
const MARKER_TTL_SECONDS = 2 * 24 * 3600
export const IN_FLIGHT_TTL_SECONDS = 25 * 60
// The business date's executions are capped by the controller under a GCS generation claim
// (active8_daily_dispatch_guard.dispatch_replay_guarded, l4_opb_replay_dispatch
// .MAX_EXECUTIONS_PER_BUSINESS_DATE, answered `capped` once the last one ended): concurrent entries
// (watchdog tick, parked continuation) cannot both start one. No Worker counter.
// `busy` answers without a break (the job is running: an OOF daily or a replay execution).
// One execution is bounded by the job timeout (3600s); busy for 2 h means back-to-back or
// stuck executions. Only an answer that settles the dispatch (spawned, capped, skipped)
// breaks the streak; dispatch_failed says nothing about the job and keeps it. A closed
// window (skipped outside_window) is answered before the claim, so it settles nothing: with
// job_running true it counts as busy (a stuck job still reaches busy_persistent after the
// window closed and over the following nights of the business date), false breaks the
// streak, unknown keeps it. The break is
// written as last_clear_at (its own key) and the streak key is deleted; a streak whose
// first_busy_at is not after last_clear_at is stale, so a lost delete or a busy write racing
// the clear never escalates. Engineering bound, not a trading parameter.
export const OPB_REPLAY_BUSY_PERSISTENT_MS = 2 * 3600_000
export const opbReplayBusySinceKey = (businessDate: string) => `opb:arm-replay:busy-since:${businessDate}`
export const opbReplayBusyClearedKey = (businessDate: string) => `opb:arm-replay:busy-cleared:${businessDate}`

type RunReceipt = { status: string; complete: number; progress: number; failed_dates_json: string;
  deferred_dates_json: string; rejected_dates_json: string; missing_price_dates_json: string; finished_at: string }
type Outstanding = { rejected?: readonly string[]; failed?: readonly string[]; missingPrice?: readonly string[];
  deferred?: readonly string[]; runFailed?: boolean; capped?: boolean; dispatch?: 'busy' | 'dispatch_failed';
  busyForMs?: number }

const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
const dates = (raw: unknown): string[] => {
  try { return list(JSON.parse(String(raw ?? '[]'))) } catch { return [] }
}

/**
 * One `attention=` token (comma-joined, no spaces): visible to the scheduler log and
 * Grafana; matches no status rule. Rejected days are terminal; failed, missing_price,
 * deferred and capped are what the night left for the next business date; run_failed
 * is a run that failed before any day (config, D1); busy and dispatch_failed are a
 * tick that could not start an execution.
 */
export const opbReplayAttention = ({ rejected = [], failed = [], missingPrice = [], deferred = [], runFailed = false,
  capped = false, dispatch, busyForMs = 0 }: Outstanding) => {
  const parts = [rejected.length ? `opb_replay_rejected:${rejected.length}` : '',
    failed.length ? `opb_replay_failed:${failed.length}` : '',
    missingPrice.length ? `opb_replay_missing_price:${missingPrice.length}` : '',
    deferred.length ? `opb_replay_deferred:${deferred.length}` : '', runFailed ? 'opb_replay_run_failed' : '',
    capped ? 'opb_replay_capped' : '',
    dispatch === 'busy' && busyForMs >= OPB_REPLAY_BUSY_PERSISTENT_MS
      ? `opb_replay_busy_persistent:${Math.floor(busyForMs / 60_000)}m`
      : dispatch ? `opb_replay_${dispatch}` : ''].filter(Boolean)
  return parts.length ? ` attention=${parts.join(',')}` : ''
}

// The controller's skip reasons. policy_not_v3 ends the business date (the OOF job owns the
// replay, as on main); outside_window ends only tonight: the controller reopens the window at
// the next OOF daily main tick, and a weekend runs one business date over several nights, so
// that marker is not terminal (the next tick asks the controller again, which answers from
// the schedule without claiming anything).
export const OPB_REPLAY_NIGHT_ONLY_SKIP = 'outside_window'
const skipReason = (raw: unknown) => String(raw ?? 'unspecified').replace(/[^\w.:-]+/g, '_').slice(0, 64) || 'unspecified'

async function markNight(env: Bindings, businessDate: string, status: string, outstanding: Outstanding, reason?: string) {
  try {
    await env.KV.put(opbIndependentReplayKey(businessDate), JSON.stringify({ status, business_date: businessDate,
      ...(reason ? { reason } : {}),
      rejected_dates: outstanding.rejected ?? [], failed_dates: outstanding.failed ?? [],
      missing_price_dates: outstanding.missingPrice ?? [], deferred_dates: outstanding.deferred ?? [],
      run_failed: Boolean(outstanding.runFailed), capped: Boolean(outstanding.capped) }), { expirationTtl: MARKER_TTL_SECONDS })
  } catch { /* a missing marker only costs one more receipt read */ }
}

async function log(env: Bindings, level: 'info' | 'warn', summary: string, meta: Record<string, unknown>) {
  try {
    await writeSystemLog(databaseForDataDomain(env, 'ops'), level, 'active8-oof-daily',
      `OPB arm replay (independent): ${summary}`, meta)
  } catch { /* the log is best effort; the replay outcome is in the ledger */ }
}

/**
 * OPB arm replay on a night the active8-oof-daily task does not dispatch the OOF job
 * (pipeline failed or still running, or waiting for premarket). Research evidence only:
 * it never changes the task's status, and a failure is logged, never thrown.
 * Asynchronous: one tick starts an execution, a later tick reads its run receipt
 * (learning l4_opb_arm_replay_runs_v1) and marks the date complete.
 * The business date ends at the first of: a complete receipt (all done, or no progress),
 * `capped` (the controller started the business date's executions), or `skipped` (reason
 * policy_not_v3: the OOF job owns the replay, as on main, for the business date; reason
 * outside_window: tonight's window closed, asked again on a later night). What is left
 * carries `attention=` on every tick, the skip reason as `reason=`.
 */
export async function dispatchIndependentOpbReplay(env: Bindings, businessDate: string): Promise<string> {
  try {
    const marker = await env.KV.get(opbIndependentReplayKey(businessDate))
    if (marker != null) {
      let outstanding: Outstanding = {}, reason = '', nightOnly = false
      try {
        const m = JSON.parse(marker)
        outstanding = { rejected: list(m.rejected_dates), failed: list(m.failed_dates),
          missingPrice: list(m.missing_price_dates), deferred: list(m.deferred_dates), runFailed: Boolean(m.run_failed),
          capped: Boolean(m.capped) }
        reason = m.reason == null ? '' : skipReason(m.reason)
        nightOnly = m.status === 'skipped' && reason === OPB_REPLAY_NIGHT_ONLY_SKIP
      } catch { /* unreadable marker: still done */ }
      if (!nightOnly) return 'opb_replay=already_done' + (reason ? ` reason=${reason}` : '') + opbReplayAttention(outstanding)
    }
  } catch { /* no marker readable: check the receipt */ }
  let receipt: RunReceipt | null = null
  try {
    receipt = await databaseForDataDomain(env, 'learning').prepare(`SELECT status,complete,progress,failed_dates_json,
        deferred_dates_json,rejected_dates_json,missing_price_dates_json,finished_at FROM l4_opb_arm_replay_runs_v1
       WHERE business_date=? ORDER BY finished_at DESC LIMIT 1`).bind(businessDate).first<RunReceipt>()
  } catch { /* unreadable: fall through to dispatch; the job is idempotent */ }
  let outstanding: Outstanding = {}
  if (receipt) {
    const failed = dates(receipt.failed_dates_json)
    outstanding = { rejected: dates(receipt.rejected_dates_json), failed, missingPrice: dates(receipt.missing_price_dates_json),
      deferred: dates(receipt.deferred_dates_json), runFailed: receipt.status === 'failed' && !failed.length }
    const meta = { business_date: businessDate, status: receipt.status, finished_at: receipt.finished_at,
      progress: Number(receipt.progress ?? 0), failed_dates: outstanding.failed, deferred_dates: outstanding.deferred,
      rejected_dates: outstanding.rejected, missing_price_dates: outstanding.missingPrice }
    if (Number(receipt.complete) === 1) {
      // Finished, or no progress: another execution for this business date would repeat the same work.
      await markNight(env, businessDate, receipt.status, outstanding)
      const summary = `opb_replay=${receipt.status}`
        + (outstanding.rejected!.length ? ` rejected=${outstanding.rejected!.length}` : '') + opbReplayAttention(outstanding)
      await log(env, summary === 'opb_replay=ok' ? 'info' : 'warn', summary, meta)
      return summary
    }
    await log(env, 'warn', `opb_replay=incomplete status=${receipt.status}`, meta)
  }
  try {
    if (await env.KV.get(opbReplayInFlightKey(businessDate)) != null) return 'opb_replay=in_flight'
  } catch { /* unreadable: the controller still refuses a second running execution */ }
  let answer: { status?: string; execution_id?: string; active_execution?: string; reason?: string; executions?: number;
    job_running?: boolean | null }
  try {
    const response = await controllerFetch(env, '/l4_distribution/opb-arm-replay', {
      method: 'POST', timeoutMs: OPB_REPLAY_DISPATCH_TIMEOUT_MS, jsonBody: { business_date: businessDate },
    })
    if (!response.ok) throw new Error(`http_${response.status}`)
    answer = await response.json() as typeof answer
  } catch (error) {
    // The busy streak is kept: an unreachable controller says nothing about the job.
    const summary = 'opb_replay=dispatch_failed' + opbReplayAttention({ dispatch: 'dispatch_failed' })
    await log(env, 'warn', summary,
      { business_date: businessDate, error: String((error as Error)?.message ?? error).slice(0, 200) })
    return summary
  }
  const meta = { business_date: businessDate, execution_id: answer.execution_id ?? null,
    active_execution: answer.active_execution ?? null, reason: answer.reason ?? null, executions: answer.executions ?? null,
    job_running: answer.job_running ?? null }
  if (answer.status === 'busy') {
    const summary = 'opb_replay=busy' + opbReplayAttention({ dispatch: 'busy', busyForMs: await busyFor(env, businessDate) })
    await log(env, 'warn', summary, meta)
    return summary
  }
  const closedWindow = answer.status === 'skipped' && skipReason(answer.reason) === OPB_REPLAY_NIGHT_ONLY_SKIP
  if (['spawned', 'capped', 'skipped'].includes(String(answer.status)) && (!closedWindow || answer.job_running === false)) {
    await clearBusy(env, businessDate)
  }
  if (answer.status === 'spawned') {
    try {
      await env.KV.put(opbReplayInFlightKey(businessDate), JSON.stringify({ execution_id: answer.execution_id ?? null }),
        { expirationTtl: IN_FLIGHT_TTL_SECONDS })
    } catch { /* without it the next tick asks again; a running execution is refused */ }
    await log(env, 'info', 'opb_replay=spawned', meta)
    return 'opb_replay=spawned'
  }
  if (answer.status === 'skipped') {
    // What the last receipt left (failed, deferred, ...) stays named on this and later ticks.
    const reason = skipReason(answer.reason)
    await markNight(env, businessDate, 'skipped', outstanding, reason)
    const attention = opbReplayAttention(closedWindow && answer.job_running === true
      ? { ...outstanding, dispatch: 'busy', busyForMs: await busyFor(env, businessDate) } : outstanding)
    const summary = `opb_replay=skipped reason=${reason}` + attention
    await log(env, reason === 'policy_not_v3' && !attention ? 'info' : 'warn', summary, meta)
    return summary
  }
  if (answer.status === 'capped') {
    // The controller started the business date's executions already; what the last receipt left stays named.
    outstanding = { ...outstanding, capped: true }
    await markNight(env, businessDate, 'capped', outstanding)
    const summary = 'opb_replay=capped' + opbReplayAttention(outstanding)
    await log(env, 'warn', summary, meta)
    return summary
  }
  // dispatch_failed (config, claim or execution list unreadable: nothing started) or unknown;
  // the busy streak is kept.
  const summary = `opb_replay=${answer.status ?? 'unknown'}` + opbReplayAttention({ dispatch: 'dispatch_failed' })
  await log(env, 'warn', summary, meta)
  return summary
}

/** How long the job has answered `busy` since the last settling answer (0 on a new streak). */
async function busyFor(env: Bindings, businessDate: string): Promise<number> {
  const now = Date.now()
  let first = now
  try {
    const [raw, cleared] = await Promise.all([env.KV.get(opbReplayBusySinceKey(businessDate)),
      env.KV.get(opbReplayBusyClearedKey(businessDate))])
    if (raw != null) {
      const seen = JSON.parse(raw) as { first_busy_at?: string; last_busy_at?: string }
      const since = Date.parse(String(seen.first_busy_at)), last = Date.parse(String(seen.last_busy_at))
      const clearedAt = cleared == null ? -Infinity : Date.parse(cleared)
      // Not after the last clear (or the clear is unreadable): a stale streak, start again.
      if (since <= last && last <= now && since > clearedAt) first = since
    }
  } catch { /* unreadable: a new streak */ }
  try {
    await env.KV.put(opbReplayBusySinceKey(businessDate), JSON.stringify({ first_busy_at: new Date(first).toISOString(),
      last_busy_at: new Date(now).toISOString() }), { expirationTtl: MARKER_TTL_SECONDS })
  } catch { /* the mark falls back to plain busy next tick */ }
  return now - first
}

/** spawned, capped or skipped: the streak ends. Two separate writes; either alone suffices. */
async function clearBusy(env: Bindings, businessDate: string) {
  try {
    await env.KV.put(opbReplayBusyClearedKey(businessDate), new Date(Date.now()).toISOString(),
      { expirationTtl: MARKER_TTL_SECONDS })
  } catch { /* the delete below still ends the streak */ }
  try { await env.KV.delete(opbReplayBusySinceKey(businessDate)) } catch { /* last_clear_at marks it stale */ }
}
