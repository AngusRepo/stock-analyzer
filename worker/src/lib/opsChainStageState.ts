/**
 * Writer for ops_chain_stage_state_v1 / ops_chain_stage_transitions_v1 (observability only).
 * - A row is written only when its status changes; the transition log gets one row per change.
 * - Status never regresses: a terminal stage goes back to running only when the attempt increases.
 * - Heartbeat: running, non-Cloud-Run stages only, at most once per 5 minutes, state table only.
 * - Repeating stages (catalog `repeat`): worst result of the day, last result refreshed at most once
 *   per 5 minutes (state table only), never running, never a heartbeat.
 * - Chains other than daily_readiness are created on their period's first write (rows all pending).
 * - Every failure is caught and warned: a write failure never breaks the business flow.
 * - Rollback: wrangler var OPS_CHAIN_STAGE_STATE_WRITES = "0" stops every write.
 * Contract: audits/grafana-obs-eval-20261124/p2p3_contract.md.
 */
import type { Bindings } from '../types'
import {
  DAILY_READINESS_CHAIN_ID,
  DAILY_READINESS_STAGE_CATALOG,
  type ChainDefinition,
  type ChainStageCatalogEntry,
  chainDefinition,
  chainStage,
  chainsOfStage,
  periodKeyFor,
  stageExpectedByUtc,
  twDateOfUtc,
} from './opsChainStageCatalog'
import { opsRuntimeEnv, opsRuntimeTicket } from './opsRuntimeScope'
import type { SchedulerRunLogEntry } from './schedulerRunLogger'

export type ChainStageStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'blocked'
const TERMINAL = new Set<ChainStageStatus>(['success', 'error', 'skipped', 'blocked'])
export const CHAIN_STAGE_HEARTBEAT_MIN_MS = 5 * 60_000
/** Longest TW market closure (Lunar New Year) is 9 calendar days; T→X lookups search this far back. */
export const CHAIN_STAGE_TRADE_DATE_LOOKBACK_DAYS = 12
const TEXT_MAX = 500
const DATE = /^\d{4}-\d{2}-\d{2}$/

const STATE = 'ops_chain_stage_state_v1'
const TRANSITIONS = 'ops_chain_stage_transitions_v1'

/**
 * A row entering running from another status starts a new run (retry): it takes the new values as
 * they are, so a retry never inherits the previous attempt's execution_name / run / ticket ids.
 * Any other change keeps an old value the new write does not name.
 */
const carry = (column: string) => `CASE WHEN excluded.status='running' AND ${STATE}.status<>'running'
        THEN excluded.${column} ELSE COALESCE(excluded.${column}, ${STATE}.${column}) END`

/** Statements, exported so the EXPLAIN QUERY PLAN test checks exactly what runs. */
export const CHAIN_STAGE_SQL = {
  read: `SELECT status, attempt, run_id, execution_name, started_at, heartbeat_at, updated_at
    FROM ${STATE} WHERE business_date=? AND chain_id=? AND stage_id=?`,
  // Insert only into a chain that was pre-created (trading day); otherwise update with a
  // compare-and-set on the status/attempt read just before, plus the no-regression rule.
  upsert: `INSERT INTO ${STATE} (business_date, chain_id, stage_id, status, optional, expected_by, attempt,
      root_ticket_id, ticket_id, run_id, execution_name, summary, error, started_at, completed_at, heartbeat_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15
     WHERE EXISTS (SELECT 1 FROM ${STATE} WHERE business_date=?1 AND chain_id=?2 AND stage_id=?18)
    ON CONFLICT(business_date, chain_id, stage_id) DO UPDATE SET
      status=excluded.status,
      attempt=max(${STATE}.attempt, excluded.attempt),
      root_ticket_id=${carry('root_ticket_id')},
      ticket_id=${carry('ticket_id')},
      run_id=${carry('run_id')},
      execution_name=${carry('execution_name')},
      summary=${carry('summary')},
      error=excluded.error,
      started_at=CASE WHEN excluded.status='running' THEN excluded.started_at
        ELSE COALESCE(${STATE}.started_at, excluded.started_at) END,
      completed_at=excluded.completed_at,
      heartbeat_at=NULL,
      updated_at=excluded.updated_at
    WHERE ${STATE}.status=?16 AND ${STATE}.attempt=?17
      AND NOT (excluded.status='running' AND ${STATE}.status IN ('success','error','skipped','blocked')
        AND excluded.attempt<=${STATE}.attempt)
    RETURNING status`,
  transition: `INSERT OR IGNORE INTO ${TRANSITIONS} (business_date, chain_id, stage_id, transition_at, to_status,
      from_status, attempt, ticket_id, run_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  // Repeating stage, status unchanged: last result only, throttled in SQL like the heartbeat.
  refresh: `UPDATE ${STATE} SET summary=?4, error=COALESCE(?5, error), run_id=COALESCE(?6, run_id),
      ticket_id=COALESCE(?7, ticket_id), completed_at=?8, updated_at=?8
    WHERE business_date=?1 AND chain_id=?2 AND stage_id=?3 AND status=?9 AND updated_at<?10`,
  // Throttled in SQL too: rows_written is 0 unless the last beat (or start) is older than 5 minutes.
  heartbeat: `UPDATE ${STATE} SET heartbeat_at=?4
    WHERE business_date=?1 AND chain_id=?2 AND stage_id=?3 AND status='running' AND execution_name IS NULL
      AND COALESCE(heartbeat_at, started_at, '')<?5`,
  executionName: `UPDATE ${STATE} SET execution_name=?4, updated_at=?5
    WHERE business_date=?1 AND chain_id=?2 AND stage_id=?3 AND status='running'
      AND COALESCE(execution_name, '')<>?4`,
  tradeDateChain: `SELECT business_date, expected_by FROM ${STATE}
    WHERE business_date>=? AND business_date<? AND chain_id=? AND stage_id=?
    ORDER BY business_date DESC LIMIT 1`,
  // Re-anchor one next-trading-day deadline of a chain whose T+1 moved (closure after pre-create).
  reanchor: `UPDATE ${STATE} SET expected_by=?4
    WHERE business_date=?1 AND chain_id=?2 AND stage_id=?3 AND COALESCE(expected_by, '')<>?4`,
  precreate: `INSERT OR IGNORE INTO ${STATE} (business_date, chain_id, stage_id, status, optional, expected_by, attempt, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, 0, ?)`,
  // Retention, per chain: one oldest business date of that chain per creation (a PK range walk that
  // stops at the first row of the chain), so a long closure's catch-up never turns one day into a
  // burst of deletes; each creation adds one date of the chain and removes at most one.
  retainState: `DELETE FROM ${STATE} WHERE chain_id=?2 AND business_date=(SELECT business_date FROM ${STATE}
    WHERE business_date<?1 AND chain_id=?2 ORDER BY business_date LIMIT 1)`,
  retainTransitions: `DELETE FROM ${TRANSITIONS} WHERE chain_id=?2 AND business_date=(SELECT business_date FROM ${TRANSITIONS}
    WHERE business_date<?1 AND chain_id=?2 ORDER BY business_date LIMIT 1)`,
} as const

/** A chain's creation anchor: its first catalog stage; its presence marks a created chain/period. */
const anchorStage = (chain: ChainDefinition) => chain.stages[0].stageId

export function chainStageWritesEnabled(env: { OPS_CHAIN_STAGE_STATE_WRITES?: string } | undefined): boolean {
  const flag = String(env?.OPS_CHAIN_STAGE_STATE_WRITES ?? '1').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(flag)
}

/** Scheduler run status → chain stage status. */
export function chainStageStatusFromRun(status: string): ChainStageStatus | null {
  if (status === 'success' || status === 'error' || status === 'skipped' || status === 'blocked') return status
  if (status === 'running' || status === 'triggered' || status === 'waiting') return 'running'
  return null
}

type PriorRow = { status: ChainStageStatus; attempt: number; run_id: string | null }

/**
 * Pure transition rule (mirrors resolveMonotonicSchedulerEntry for the KV run log):
 * pending/running → anything; terminal → running only on a higher attempt; the same terminal status
 * only from a newer attempt or run (refresh); success is not
 * replaced by skipped/blocked, and by error only from a newer attempt or run; error is replaced by
 * success, otherwise only from a newer attempt or run; skipped/blocked → any terminal.
 */
export function chainStageTransitionAllowed(
  prev: PriorRow,
  next: { status: ChainStageStatus; attempt: number; runId?: string | null },
): boolean {
  if (next.status === 'pending') return false
  const newer = next.attempt > prev.attempt || Boolean(next.runId && prev.run_id && next.runId !== prev.run_id)
  // The same terminal status from a newer attempt/run refreshes attempt, error, run_id, completed_at.
  if (next.status === prev.status) return TERMINAL.has(next.status) && newer
  if (prev.status === 'pending' || prev.status === 'running') return true
  if (next.status === 'running') return next.attempt > prev.attempt
  if (prev.status === 'success') return next.status === 'error' && newer
  if (prev.status === 'error') return next.status === 'success' || newer
  return true
}

export interface ChainStageWrite {
  businessDate: string
  stageId: string
  status: ChainStageStatus
  chainId?: string
  attempt?: number
  rootTicketId?: string | null
  ticketId?: string | null
  runId?: string | null
  executionName?: string | null
  summary?: string | null
  error?: string | null
  nowMs?: number
}

export type ChainStageWriteOutcome =
  | 'written' | 'unchanged' | 'heartbeat' | 'refreshed' | 'execution_name' | 'rejected' | 'not_precreated' | 'conflict' | 'invalid'

const clip = (value: string | null | undefined): string | null => {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, TEXT_MAX) : null
}

/** Compare-and-set attempts per write: two writers racing on one stage (progress callback vs run log). */
export const CHAIN_STAGE_CAS_ATTEMPTS = 3

/** Core write against OPS_DB. Throws on D1 errors; callers use recordChainStage (never throws). */
export async function writeChainStageState(db: D1Database, input: ChainStageWrite): Promise<ChainStageWriteOutcome> {
  const chainId = input.chainId ?? DAILY_READINESS_CHAIN_ID
  if (!DATE.test(input.businessDate) || !chainStage(chainId, input.stageId) || input.status === 'pending') return 'invalid'
  for (let round = 1; ; round++) {
    const outcome = await writeChainStageStateOnce(db, input)
    // A lost race re-reads the row and re-decides; the transition rule still applies to the winner's state.
    if (outcome !== 'conflict' || round >= CHAIN_STAGE_CAS_ATTEMPTS) return outcome
  }
}

async function writeChainStageStateOnce(db: D1Database, input: ChainStageWrite): Promise<ChainStageWriteOutcome> {
  const chain = chainDefinition(input.chainId ?? DAILY_READINESS_CHAIN_ID)!
  const entry = chainStage(chain.chainId, input.stageId)!
  const nowMs = input.nowMs ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const attempt = Number.isSafeInteger(input.attempt) && input.attempt! > 0 ? input.attempt! : 0
  const key = [input.businessDate, chain.chainId, input.stageId] as const
  const prior = await db.prepare(CHAIN_STAGE_SQL.read).bind(...key).first<PriorRow & {
    execution_name: string | null; started_at: string | null; heartbeat_at: string | null; updated_at: string }>()
  const upsert = (write: ChainStageWrite) => upsertChainStage(db, chain, key, entry, write, attempt, now, prior)

  if (entry.repeat) {
    // Sources report only results; a running write would reopen a settled day (and arm stuck checks).
    if (input.status === 'running') return 'unchanged'
    const summary = clip(`last=${input.status}${input.summary ? ` ${input.summary}` : ''}`)
    if (!prior || REPEAT_SEVERITY[input.status] > REPEAT_SEVERITY[prior.status]) return upsert({ ...input, summary })
    // Not worse than the day so far: keep the status, record the last result at most every 5 minutes.
    const cutoff = new Date(nowMs - CHAIN_STAGE_HEARTBEAT_MIN_MS).toISOString()
    if (prior.updated_at >= cutoff) return 'unchanged'
    const result = await db.prepare(CHAIN_STAGE_SQL.refresh).bind(...key, summary,
      input.status === 'success' ? null : clip(input.error), clip(input.runId), clip(input.ticketId), now, prior.status, cutoff).run()
    return Number(result.meta?.changes ?? 0) > 0 ? 'refreshed' : 'unchanged'
  }

  if (prior && prior.status === input.status) {
    if (input.status !== 'running') {
      if (!chainStageTransitionAllowed(prior, { status: input.status, attempt, runId: input.runId })) return 'unchanged'
      return upsert(input)
    }
    const executionName = clip(input.executionName)
    if (executionName && executionName !== prior.execution_name) {
      const result = await db.prepare(CHAIN_STAGE_SQL.executionName).bind(...key, executionName, now).run()
      return Number(result.meta?.changes ?? 0) > 0 ? 'execution_name' : 'unchanged'
    }
    // Cloud Run stages: liveness comes from the Cloud Run execution, not a D1 heartbeat.
    if (prior.execution_name) return 'unchanged'
    const cutoff = new Date(nowMs - CHAIN_STAGE_HEARTBEAT_MIN_MS).toISOString()
    if ((prior.heartbeat_at ?? prior.started_at ?? '') >= cutoff) return 'unchanged'
    const result = await db.prepare(CHAIN_STAGE_SQL.heartbeat).bind(...key, now, cutoff).run()
    return Number(result.meta?.changes ?? 0) > 0 ? 'heartbeat' : 'unchanged'
  }
  if (prior && !chainStageTransitionAllowed(prior, { status: input.status, attempt, runId: input.runId })) return 'rejected'
  return upsert(input)
}

/**
 * Repeating stages: the day's status only moves to a worse result. skipped < success < blocked <
 * error, so a day that ran shows success, and one error (or block) stays until the day ends.
 */
const REPEAT_SEVERITY: Record<ChainStageStatus, number> = { pending: 0, running: 0, skipped: 1, success: 2, blocked: 3, error: 4 }

async function upsertChainStage(db: D1Database, chain: ChainDefinition, key: readonly [string, string, string],
  entry: ChainStageCatalogEntry, input: ChainStageWrite, attempt: number, now: string, prior: PriorRow | null,
): Promise<ChainStageWriteOutcome> {
  const terminal = TERMINAL.has(input.status)
  const changed = await db.prepare(CHAIN_STAGE_SQL.upsert).bind(
    ...key, input.status, entry.optional ? 1 : 0, attempt,
    clip(input.rootTicketId), clip(input.ticketId), clip(input.runId), clip(input.executionName),
    clip(input.summary), input.status === 'success' ? null : clip(input.error),
    // A repeating stage never runs; started_at keeps its first result of the day (COALESCE in SQL).
    input.status === 'running' || entry.repeat ? now : null, terminal ? now : null, now,
    prior?.status ?? '', prior?.attempt ?? 0, anchorStage(chain),
  ).first<{ status: string }>()
  if (!changed) return prior ? 'conflict' : 'not_precreated'
  await db.prepare(CHAIN_STAGE_SQL.transition).bind(
    ...key, now, input.status, prior?.status ?? null, attempt, clip(input.ticketId), clip(input.runId), clip(input.summary),
  ).run()
  return 'written'
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The row whose expected_by names chain X's next trading day: the first required stage anchored on
 * T+1 (pipeline). Optional stages have expected_by NULL, so their own rows cannot map a date.
 */
export const TRADE_DATE_ANCHOR_STAGE = DAILY_READINESS_STAGE_CATALOG
  .find(entry => entry.expectedBy?.anchor === 'next_trading_day')!.stageId

/** The existing trading calendar (schedulerPolicy), injected so the resolver stays testable. */
export interface TradeDateCalendar {
  isTradingDay(date: string): Promise<boolean>
  nextTradingDay(date: string): Promise<string | null>
}

/**
 * A stage that stamps the trade date T (pre-market stages) belongs to chain X, the last trading day
 * before T: T must be a trading day (calendar), and the latest chain before T has an anchor row
 * expecting its next trading day on T. When the anchor disagrees (T+1 unresolved at pre-create, or an unplanned closure such as a typhoon day after
 * X), the calendar decides: T must be a trading day and the next trading day after X. Without a
 * calendar the mismatch is refused, so a holiday-stamped run never lands on a chain.
 */
export async function resolveTradeDateChain(db: D1Database, tradeDate: string,
  chainId = DAILY_READINESS_CHAIN_ID, calendar?: TradeDateCalendar): Promise<{ businessDate: string; reanchor: boolean } | null> {
  if (!DATE.test(tradeDate)) return null
  const row = await db.prepare(CHAIN_STAGE_SQL.tradeDateChain)
    .bind(daysBefore(tradeDate, CHAIN_STAGE_TRADE_DATE_LOOKBACK_DAYS), tradeDate, chainId, TRADE_DATE_ANCHOR_STAGE)
    .first<{ business_date: string; expected_by: string | null }>()
  if (!row) return null
  // A run stamped with a closed day (holiday, or a typhoon closure after pre-create) never lands.
  if (calendar && !(await calendar.isTradingDay(tradeDate))) return null
  if (row.expected_by != null && twDateOfUtc(row.expected_by) === tradeDate) return { businessDate: row.business_date, reanchor: false }
  if (!calendar) return null
  return (await calendar.nextTradingDay(row.business_date)) === tradeDate
    ? { businessDate: row.business_date, reanchor: true } : null
}

/**
 * Chain X's T+1 turned out to be T (unresolved at pre-create, or the stored day closed afterwards):
 * rewrite its next-trading-day deadlines once, so overdue judgement uses the real T. ≤ 33 PK updates,
 * only on that rare event; afterwards the anchor matches and this never runs again for X.
 */
export async function reanchorNextTradingDeadlines(db: D1Database, businessDate: string, nextTradingDate: string,
  chainId = DAILY_READINESS_CHAIN_ID): Promise<number> {
  const statements = DAILY_READINESS_STAGE_CATALOG
    .filter(entry => entry.expectedBy?.anchor === 'next_trading_day')
    .map(entry => db.prepare(CHAIN_STAGE_SQL.reanchor).bind(businessDate, chainId, entry.stageId,
      stageExpectedByUtc(businessDate, entry, nextTradingDate)))
  const results = await db.batch(statements)
  return results.reduce((sum, r) => sum + Number(r.meta?.changes ?? 0), 0)
}

async function schedulerTradeDateCalendar(env: Bindings): Promise<TradeDateCalendar> {
  const { resolveTwTradingSession, nextTwTradingDate } = await import('./schedulerPolicy')
  return {
    isTradingDay: async date => (await resolveTwTradingSession(env.KV, date, env)).trading,
    nextTradingDay: date => nextTwTradingDate(env.KV, date),
  }
}

export interface ChainStageRecordInput extends ChainStageWrite {
  /** 'run_date': businessDate is the source's run_date (mapped to X for trade_date stages). */
  dateKind?: 'business_date' | 'run_date'
}

export type ChainStageRecordOutcome = ChainStageWriteOutcome | 'disabled' | 'no_env' | 'no_db' | 'not_cataloged' | 'failed'

function warn(message: string, error?: unknown) {
  const detail = error instanceof Error ? error.message : error == null ? '' : String(error)
  console.warn(`[opsChainStageState] ${message}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
}

/** Safe entry point: resolves env (argument or request scope), flag, date mapping; never throws. */
export async function recordChainStage(input: ChainStageRecordInput, envArg?: Bindings): Promise<ChainStageRecordOutcome> {
  try {
    const env = envArg ?? opsRuntimeEnv()
    if (!env) return 'no_env'
    if (!chainStageWritesEnabled(env)) return 'disabled'
    const db = env.OPS_DB
    if (!db) return 'no_db'
    const chain = chainDefinition(input.chainId ?? DAILY_READINESS_CHAIN_ID)
    const entry = chain && chainStage(chain.chainId, input.stageId)
    if (!chain || !entry) return 'not_cataloged'
    // Weekly / monthly: the run's TW date → the period key (weekend runs, Monday re-runs included).
    let businessDate = chain.period === 'trading_day' ? input.businessDate : periodKeyFor(chain.chainId, input.businessDate) ?? input.businessDate
    if (input.dateKind === 'run_date' && entry.sourceDate === 'trade_date') {
      const resolved = await resolveTradeDateChain(db, businessDate, input.chainId, await schedulerTradeDateCalendar(env))
      if (!resolved) return 'not_precreated'
      if (resolved.reanchor) {
        const moved = await reanchorNextTradingDeadlines(db, resolved.businessDate, businessDate, input.chainId)
        warn(`chain ${resolved.businessDate}: next trading day is ${businessDate}; ${moved} deadlines re-anchored`)
      }
      businessDate = resolved.businessDate
    }
    const ticket = opsRuntimeTicket()
    const write = () => writeChainStageState(db, {
      ...input,
      businessDate,
      rootTicketId: input.rootTicketId ?? ticket?.rootTicketId ?? null,
      ticketId: input.ticketId ?? (ticket?.task === input.stageId ? ticket.ticketId : null),
      attempt: input.attempt ?? (ticket?.task === input.stageId ? ticket.attempt : undefined),
    })
    let outcome = await write()
    // The period's first write creates the whole chain (once per period), then lands.
    if (outcome === 'not_precreated' && chain.creation === 'first_write'
      && await createChainOnFirstWrite(env, db, chain, businessDate)) outcome = await write()
    if (outcome === 'written') {
      // L1: one structured line per state change; root_ticket_id joins Worker and Cloud Logging.
      console.log(JSON.stringify({ event: 'ops_chain_stage', chain_id: input.chainId ?? DAILY_READINESS_CHAIN_ID,
        business_date: businessDate, stage_id: input.stageId, status: input.status,
        root_ticket_id: input.rootTicketId ?? ticket?.rootTicketId ?? null, execution_name: input.executionName ?? null }))
    }
    return outcome
  } catch (error) {
    warn(`write failed (ignored) stage=${input.stageId} date=${input.businessDate}`, error)
    return 'failed'
  }
}

function attemptFromId(attemptId: unknown): number | undefined {
  const match = /:attempt:(\d+)$/.exec(String(attemptId ?? ''))
  return match ? Number(match[1]) : undefined
}

export interface SchedulerRunForChain {
  status: string
  summary?: string
  error?: string
  run_id?: string
  attempt_id?: string
  run_date?: string
  run_scope?: string
  timestamp?: string
  duration_ms?: number
}

/**
 * Hook for logSchedulerRunResult: records a cataloged task's state, and for `pipeline` the two
 * children derived exactly as schedulerStatus.ts derives them. Never throws.
 */
export async function recordSchedulerRunChainStage(task: string, entry: SchedulerRunForChain, env?: Bindings): Promise<void> {
  try {
    if (entry.run_scope === 'historical_replay' || !entry.run_date) return
    const status = chainStageStatusFromRun(entry.status)
    // A task in several chains (none today) is recorded in each.
    for (const chainId of status ? chainsOfStage(task) : []) {
      if (!chainStage(chainId, task)!.sources.includes('scheduler_run_log')) continue
      await recordChainStage({ chainId, stageId: task, businessDate: entry.run_date, dateKind: 'run_date', status: status!,
        attempt: attemptFromId(entry.attempt_id), runId: entry.run_id, summary: entry.summary, error: entry.error }, env)
    }
    if (task === 'pipeline') await recordPipelineChildren(entry, env)
  } catch (error) {
    warn(`scheduler run hook failed (ignored) task=${task}`, error)
  }
}

async function recordPipelineChildren(entry: SchedulerRunForChain, env?: Bindings): Promise<void> {
  const { inferPipelineChildLog } = await import('./schedulerStatus')
  const parent = { task: 'pipeline', status: entry.status, summary: entry.summary ?? '', duration_ms: entry.duration_ms ?? 0,
    timestamp: entry.timestamp ?? '', run_id: entry.run_id, run_date: entry.run_date } as SchedulerRunLogEntry
  for (const child of ['ml-predict', 'recommendation'] as const) {
    let derived: { status: string; summary?: string } | undefined = inferPipelineChildLog([parent], child)
    // The authenticated L3 handoff (schedulerPipelinePhase.sealedPremarketDisplay): L3 is done.
    if (!derived && child === 'ml-predict' && entry.status === 'triggered'
      && /\bl3_sealed=true\b/.test(entry.summary ?? '')) derived = { status: 'success', summary: 'derived from pipeline: L3 sealed' }
    const status = derived ? chainStageStatusFromRun(derived.status) : null
    if (!status) continue
    await recordChainStage({ stageId: child, businessDate: entry.run_date!, status, runId: entry.run_id,
      summary: derived!.summary }, env)
  }
}

export interface PrecreateResult { inserted: number; deletedState: number; deletedTransitions: number }

/**
 * Create every catalog row of a chain as pending for business date X (idempotent), then trim that
 * chain's retention. `noDeadline` stages get expected_by NULL (a PAUSED scheduler job never runs).
 */
export async function precreateChainRows(db: D1Database, input: {
  chainId: string; businessDate: string; nextTradingDate?: string | null; nowMs?: number
  noDeadline?: (stageId: string) => boolean
}): Promise<PrecreateResult> {
  const chain = chainDefinition(input.chainId)
  if (!chain) throw new Error('chain_precreate_chain_unknown')
  if (!DATE.test(input.businessDate)) throw new Error('chain_precreate_date_invalid')
  const now = new Date(input.nowMs ?? Date.now()).toISOString()
  const statements = chain.stages.map(entry => db.prepare(CHAIN_STAGE_SQL.precreate).bind(
    input.businessDate, chain.chainId, entry.stageId, entry.optional ? 1 : 0,
    input.noDeadline?.(entry.stageId) ? null : stageExpectedByUtc(input.businessDate, entry, input.nextTradingDate), now))
  const results = await db.batch(statements)
  const inserted = results.reduce((sum, r) => sum + Number(r.meta?.changes ?? 0), 0)
  const cutoff = daysBefore(input.businessDate, chain.retentionDays)
  const [state, transitions] = await db.batch([
    db.prepare(CHAIN_STAGE_SQL.retainState).bind(cutoff, chain.chainId),
    db.prepare(CHAIN_STAGE_SQL.retainTransitions).bind(cutoff, chain.chainId),
  ])
  return { inserted, deletedState: Number(state.meta?.changes ?? 0), deletedTransitions: Number(transitions.meta?.changes ?? 0) }
}

/** Pre-create every daily_readiness row as pending for business date X, then trim retention. */
export async function precreateDailyReadinessChain(db: D1Database, input: {
  businessDate: string; nextTradingDate: string | null; nowMs?: number
}): Promise<PrecreateResult> {
  return precreateChainRows(db, { ...input, chainId: DAILY_READINESS_CHAIN_ID })
}

/**
 * First write of a 'first_write' chain's period: a trading-day chain only on a TW trading day (the
 * same resolveTwTradingSession owner, so a holiday's policy skips create nothing); weekly / monthly
 * always (their period key comes from periodKeyFor). Stages the scheduler manifest keeps PAUSED get
 * no deadline, the cadenceReadiness rule. Returns whether the rows now exist.
 */
async function createChainOnFirstWrite(env: Bindings, db: D1Database, chain: ChainDefinition, businessDate: string): Promise<boolean> {
  if (chain.period === 'trading_day') {
    const { resolveTwTradingSession } = await import('./schedulerPolicy')
    if (!(await resolveTwTradingSession(env.KV, businessDate, env)).trading) return false
  }
  const { schedulerJobAccounting } = await import('./schedulerManifestGovernance')
  const result = await precreateChainRows(db, { chainId: chain.chainId, businessDate,
    noDeadline: stageId => schedulerJobAccounting(stageId).desiredState === 'PAUSED' })
  console.log(JSON.stringify({ event: 'ops_chain_created', chain_id: chain.chainId, business_date: businessDate,
    inserted: result.inserted, retention_deleted: result.deletedState + result.deletedTransitions }))
  return true
}

/**
 * market-close-refresh step: trading days only (the existing resolveTwTradingSession owner), next
 * trading day via the existing nextTwTradingDate. Never throws; returns a short receipt.
 */
export async function precreateDailyReadinessChainForDate(env: Bindings, businessDate: string): Promise<string> {
  try {
    if (!chainStageWritesEnabled(env)) return 'chain_state=disabled'
    if (!env.OPS_DB) return 'chain_state=no_db'
    const { resolveTwTradingSession, nextTwTradingDate } = await import('./schedulerPolicy')
    const session = await resolveTwTradingSession(env.KV, businessDate, env)
    if (!session.trading) return `chain_state=skipped_non_trading:${session.reason}`
    let next: string | null = null
    try { next = await nextTwTradingDate(env.KV, businessDate) } catch (error) {
      warn(`next trading day unresolved after ${businessDate}; T+1 deadlines left NULL`, error)
    }
    const result = await precreateDailyReadinessChain(env.OPS_DB, { businessDate, nextTradingDate: next })
    return `chain_state=precreated:${result.inserted} retention_deleted=${result.deletedState}+${result.deletedTransitions}`
  } catch (error) {
    warn(`pre-create failed (ignored) date=${businessDate}`, error)
    return 'chain_state=failed'
  }
}
