/** Chain state endpoints over the P2 tables (p2p3_contract.md). Every read is a primary-key prefix seek:
 * business_date first, chain_id second. Judgments (failed / overdue / stuck / missed, the active business date,
 * the status a node is coloured by) are computed here; Grafana only compares counts to thresholds.
 * /v1/chain/state also carries the FinLab and pipeline sub-stage cards (chainSubStages.ts).
 * Chains (contract "P2b 擴充"): daily_readiness (default) and intraday_guard are judged per trading day;
 * weekly_research / monthly_artifact per period key (periodKeyFor), ignoring the trading calendar. History and
 * timeline read exact (business_date, chain_id) keys (IN lists): a business_date range would also walk every
 * other chain's rows of those dates (measured with all four chains seeded: daily timeline 893 → 1,202 rows_read). */
import { currentStage, scopeById, scopeDisplayStageIds, statusLabel, visualStatus, STAGES } from './judgment/executionChainDag'
import { dailyPhaseForStage } from './judgment/dailyReadinessPhases'
import { CHAIN_IDS, CHAIN_SPECS, isWatcherStage, periodKeyFor, periodKeys, previousPeriodKey, REPEAT_STALL_AFTER_MS, type ChainId, type ChainSpec } from './judgment/chainCatalog'
import { stageWait } from './judgment/stageWait'
import { chainPhaseForStage, chainStageIds } from './judgment/chainPhases'
import type { SchedulerJob } from './judgment/schedulerJob'
import { readStageProgress, subStageCards, type SubStageCard } from './chainSubStages'
import { addDays, memoized, twDate, TW_OFFSET_MS, type MonitoringEnv } from './env'
import { isTradingDay, resolveBusinessDates, type BusinessDates } from './tradingDay'

export const CHAIN_ID = 'daily_readiness'
export const CHAIN_ROOT_STAGE = 'market-close-refresh'
export const STUCK_AFTER_MS = 15 * 60_000
/** p2p3_contract.md: the first stage's deadline. A trading day still without any chain row after it is missed. */
export const CHAIN_ROOT_DEADLINE_TW = '18:30'
/** P2's catalog (opsChainStageCatalog.ts) has 33 stages: state reads 2 × 33 rows (X and X−1) and a 14-day
 * timeline ≈ 10 trading days × 33 stages × ~3 transitions. The LIMITs only bound a runaway catalog. */
export const STATE_ROW_LIMIT = 200
export const TIMELINE_ROW_LIMIT = 1500
export const TIMELINE_MAX_DAYS = 14
/** Chains before X−1 have ended (X−1's last stage is due on X): their transitions are read once an hour. */
export const TIMELINE_HISTORY_TTL_S = 3600
/** 14 days hold at most 11 trading days × 33 stages; the LIMIT only bounds a runaway catalog. */
export const HISTORY_ROW_LIMIT = 600
/** Fewer finished days than this give no typical finishing time (no ETA). */
export const ETA_MIN_SAMPLES = 3
/** A week / month period has ended once the next one starts (a later re-run belongs to the current period):
 * its rows and transitions are read once per 6 hours. */
export const PERIOD_ENDED_TTL_S = 6 * 3600

export type ChainStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'blocked'

export type ChainStateRow = {
  business_date: string
  chain_id: string
  stage_id: string
  status: ChainStatus
  optional: number
  expected_by: string | null
  attempt: number
  root_ticket_id: string | null
  ticket_id: string | null
  run_id: string | null
  execution_name: string | null
  summary: string | null
  error: string | null
  started_at: string | null
  completed_at: string | null
  heartbeat_at: string | null
  updated_at: string
}

export const STATE_SQL = `SELECT business_date, chain_id, stage_id, status, optional, expected_by, attempt, root_ticket_id,
       ticket_id, run_id, execution_name, summary, error, started_at, completed_at, heartbeat_at, updated_at
  FROM ops_chain_stage_state_v1
 WHERE business_date IN (?, ?) AND chain_id = ?
 LIMIT ${STATE_ROW_LIMIT}`

export type ChainHistoryRow = Pick<ChainStateRow, 'business_date' | 'stage_id' | 'status' | 'optional' | 'expected_by' | 'attempt' | 'error'
  | 'started_at' | 'completed_at'>

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ')
/** History and timeline: one primary-key seek per (business_date, chain_id), each billed as its rows plus about
 * two. The IN list on the leading key column is walked in key order, so ORDER BY business_date alone is a reverse
 * primary-key walk (no temp B-tree) and a truncation drops the oldest dates, never X. A full ORDER BY adds a temp
 * B-tree that D1 bills as a second read of every row (measured: 300 rows → rows_read 601); the finer order is
 * applied in JS. */
export const keyedHistorySql = (dates: number) => `SELECT business_date, stage_id, status, optional, expected_by, attempt, error, started_at, completed_at
  FROM ops_chain_stage_state_v1
 WHERE business_date IN (${placeholders(dates)}) AND chain_id = ?
 ORDER BY business_date DESC
 LIMIT ${HISTORY_ROW_LIMIT + 1}`
export const keyedTimelineSql = (dates: number) => `SELECT business_date, stage_id, transition_at, to_status, from_status, attempt, ticket_id, run_id, summary
  FROM ops_chain_stage_transitions_v1
 WHERE business_date IN (${placeholders(dates)}) AND chain_id = ?
 ORDER BY business_date DESC
 LIMIT ${TIMELINE_ROW_LIMIT + 1}`

const byTransition = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a.business_date).localeCompare(String(b.business_date)) || String(a.stage_id).localeCompare(String(b.stage_id))
  || String(a.transition_at).localeCompare(String(b.transition_at))

/** blocked: a watcher (intraday-check) whose day's worst result is blocked once its first-result deadline has passed —
 * a warning of its own ("被擋住"), never overdue (Wei 11/26). A non-watcher's blocked status raises nothing, as before. */
export type AlertKind = 'failed' | 'overdue' | 'stuck' | 'missed' | 'blocked'

export type ChainAlert = {
  business_date: string
  stage_id: string
  kind: AlertKind
  severity: 'critical' | 'warning'
  status: ChainStatus | 'absent'
  attempt: number
  expected_by: string | null
  since: string | null
  minutes: number | null
  summary: string | null
  error: string | null
  root_ticket_id: string | null
  ticket_id: string | null
  run_id: string | null
  execution_name: string | null
}

const parse = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN)
/** One timestamp shape for every reader: Python writers store microseconds and `+00:00`, and Grafana's
 * JSONata reads those as the date's midnight. A stamp with no zone is UTC (SQLite datetime()); a date alone stays as is. */
export function isoStamp(value: unknown): unknown {
  if (typeof value !== 'string' || !/\d{2}:\d{2}/.test(value)) return value
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}
const STAMP_FIELDS = ['started_at', 'completed_at', 'heartbeat_at', 'updated_at', 'transition_at'] as const
const withIsoStamps = <T extends Record<string, unknown>>(row: T): T =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, (STAMP_FIELDS as readonly string[]).includes(key) ? isoStamp(value) : value])) as T
const minutesSince = (fromMs: number, nowMs: number) => (Number.isFinite(fromMs) ? Math.floor((nowMs - fromMs) / 60_000) : null)

function alert(row: ChainStateRow, kind: AlertKind, since: string | null, nowMs: number): ChainAlert {
  return {
    business_date: row.business_date, stage_id: row.stage_id, kind,
    severity: kind === 'failed' || kind === 'missed' ? 'critical' : 'warning',
    status: row.status, attempt: Number(row.attempt ?? 0),
    expected_by: isoStamp(row.expected_by) as string | null, since: isoStamp(since) as string | null,
    minutes: minutesSince(parse(since), nowMs), summary: row.summary, error: row.error,
    root_ticket_id: row.root_ticket_id, ticket_id: row.ticket_id, run_id: row.run_id, execution_name: row.execution_name,
  }
}

/** Taiwan calendar date of an ISO instant. */
const twDateOf = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + TW_OFFSET_MS).toISOString().slice(0, 10) : null)

/** The contract's four rules for one trading day's (or period's) rows. Callers pass only judged dates (holidays: none).
 * `closedDeadlineDates`: Taiwan dates that are not trading days; a deadline on one is stale (T+1 closed after
 * pre-creation; P2 rewrites it when T's first premarket stage lands), so it raises no overdue. Daily only.
 * `rootStage`: a pre-created root still pending after its deadline is missed (daily); the other chains create
 * their rows on the period's first write, so for them missed is "no row at all" (chainAlerts) and null here. */
export function judgeStageRows(rows: ChainStateRow[], nowMs: number, closedDeadlineDates: Set<string> = new Set(),
  rootStage: string | null = CHAIN_ROOT_STAGE): ChainAlert[] {
  const out: ChainAlert[] = []
  for (const row of rows) {
    // Failed: any error, optional stages included.
    if (row.status === 'error') out.push(alert(row, 'failed', row.completed_at ?? row.updated_at, nowMs))
    // Optional stages count only failures.
    if (Number(row.optional) === 1) continue
    const expected = parse(row.expected_by)
    const staleDeadline = closedDeadlineDates.has(twDateOf(row.expected_by) ?? '')
    // Overdue excludes error: failed already covers it, so one failure raises one alert (contract 11/25). A retry
    // that turns it back to running and then passes the deadline is overdue again. A watcher's expected_by is its
    // first result's deadline (its completed_at is the last result): overdue only while it has no result at all.
    const unfinished = isWatcherStage(row.chain_id, row.stage_id) ? row.status === 'pending'
      : row.status !== 'success' && row.status !== 'skipped' && row.status !== 'error'
    if (Number.isFinite(expected) && expected < nowMs && !staleDeadline && unfinished) {
      out.push(alert(row, 'overdue', row.expected_by, nowMs))
    }
    // A watcher blocked past its first-result deadline: the guard is being held back, not late.
    if (isWatcherStage(row.chain_id, row.stage_id) && row.status === 'blocked' && Number.isFinite(expected) && expected < nowMs && !staleDeadline) {
      out.push(alert(row, 'blocked', row.expected_by, nowMs))
    }
    // Stuck (contract 11/25): a stage that did heartbeat and then stopped for 15 minutes. Most stages write
    // running once and never heartbeat (overdue covers them); Cloud Run stages are GCP alerting's. A stage parked
    // on a scheduled dispatch (stageWait) is waiting by design, not stuck; once released, the 15 minutes count from
    // the later of its last beat and its wait_until (the KV run log's stall SLA, schedulerStatus resolveSchedulerLogStatus).
    const wait = stageWait(row, nowMs)
    const quietSince = Math.max(parse(row.heartbeat_at), Number.isFinite(parse(wait.wait_until)) ? parse(wait.wait_until) : Number.NEGATIVE_INFINITY)
    if (row.status === 'running' && !row.execution_name && row.heartbeat_at && !wait.waiting && quietSince < nowMs - STUCK_AFTER_MS) {
      out.push(alert(row, 'stuck', quietSince > parse(row.heartbeat_at) ? wait.wait_until : row.heartbeat_at, nowMs))
    }
    // Missed: the chain root never started after its deadline.
    if (row.stage_id === rootStage && row.status === 'pending' && Number.isFinite(expected) && expected < nowMs) {
      out.push(alert(row, 'missed', row.expected_by, nowMs))
    }
  }
  return out
}

/** "HH:MM" Taiwan time on business date → epoch ms, or null when unset/invalid. */
export function twTimeOn(date: string, hhmm: string | undefined): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null
  return Date.parse(`${date}T${match[1]}:${match[2]}:00Z`) - TW_OFFSET_MS
}

export async function readChainState(env: MonitoringEnv, dates: BusinessDates, chainId: ChainId = CHAIN_ID): Promise<ChainStateRow[]> {
  const result = await env.OPS_DB.prepare(STATE_SQL).bind(dates.x, dates.xPrev ?? dates.x, chainId).all<ChainStateRow>()
  return result.results ?? []
}

/** Business dates of one chain. `judged`: the dates whose rows raise alerts — trading days among X and X−1
 * (daily, intraday); the current period only (week, month: the previous one has ended, shown for comparison). */
export type ChainDates = BusinessDates & { chain: ChainSpec; judged: Set<string> }

export async function resolveChainDates(env: MonitoringEnv, nowMs: number, chainId: ChainId, requested?: string | null): Promise<ChainDates> {
  const chain = CHAIN_SPECS[chainId]
  if (chain.period === 'trading_day') {
    const dates = await resolveBusinessDates(env, nowMs, requested)
    return { ...dates, chain, judged: tradingDateSet(dates) }
  }
  const today = twDate(nowMs)
  const x = periodKeyFor(chainId, requested ?? today)!
  return { x, xTrading: false, xPrev: previousPeriodKey(chainId, x), today, chain, judged: new Set([x]) }
}

const isDaily = (dates: ChainDates) => dates.chain.chainId === CHAIN_ID
/** Trading-day flag of a date in the responses; null for week / month chains (no calendar). */
const tradingFlag = (dates: ChainDates, date: string) => (dates.chain.period === 'trading_day' ? dates.judged.has(date) : null)

/** The current period live, the ended previous one from the memo (week / month); X and X−1 in one seek otherwise. */
async function readStateRows(env: MonitoringEnv, dates: ChainDates): Promise<ChainStateRow[]> {
  const { chainId, period } = dates.chain
  if (period === 'trading_day') return readChainState(env, dates, chainId)
  const read = async (date: string) => (await env.OPS_DB.prepare(STATE_SQL).bind(date, date, chainId).all<ChainStateRow>()).results ?? []
  const previous = dates.xPrev
    ? await memoized(env.MEMO, `chain-state|${chainId}|${dates.xPrev}`, PERIOD_ENDED_TTL_S, () => read(dates.xPrev!))
    : []
  return [...await read(dates.x), ...previous]
}

const DAILY = scopeById('daily_readiness')
const DAILY_ORDER = new Map(scopeDisplayStageIds(DAILY).map((id, index) => [id, index]))
/** Display order per chain: the daily panel order (cards in place of their parents), else chainStageIds. */
const ORDERS = new Map<ChainId, Map<string, number>>(CHAIN_IDS.map((id) => [id,
  id === CHAIN_ID ? DAILY_ORDER : new Map(chainStageIds(id).map((stage, index) => [stage, index]))]))
const orderOf = (chainId: ChainId) => ORDERS.get(chainId)!

const JOB_STATUS: Record<ChainStatus, SchedulerJob['lastStatus']> = {
  success: 'success', error: 'failed', running: 'running', pending: 'waiting', skipped: 'skip', blocked: 'blocked',
}

/** A state row as the panel's SchedulerJob, so the copied DAG classification applies unchanged. */
export function stateRowJob(row: ChainStateRow): SchedulerJob {
  return {
    id: row.stage_id, name: STAGES[row.stage_id]?.label ?? row.stage_id,
    lastStatus: JOB_STATUS[row.status] ?? 'waiting',
    // Pre-created and never started is "not started", not a waiting downstream.
    ...(row.status === 'pending' ? { stageVisualStatus: 'not_started' as const } : {}),
    summary: row.summary ?? '', lastError: row.error ?? undefined, statusRunDate: row.business_date,
    runId: row.run_id, attemptCount: row.attempt, lastRunAt: row.started_at, lastRun: row.started_at ?? 'N/A',
  } as SchedulerJob
}

type StageKey = Pick<ChainStateRow, 'business_date' | 'stage_id'>

const stageOrderFor = (order: Map<string, number>) => (a: StageKey, b: StageKey): number => b.business_date.localeCompare(a.business_date)
  || (order.get(a.stage_id) ?? 9999) - (order.get(b.stage_id) ?? 9999)
  || a.stage_id.localeCompare(b.stage_id)

/** Deadline dates that are not trading days (a handful of KV reads: the distinct Taiwan dates of expected_by). */
async function closedDeadlineDates(env: MonitoringEnv, rows: ChainStateRow[], tradingDates: Set<string>): Promise<Set<string>> {
  const deadlineDates = [...new Set(rows.map((row) => twDateOf(row.expected_by)).filter((date): date is string => Boolean(date)))]
  const closed = new Set<string>()
  for (const date of deadlineDates) if (!tradingDates.has(date) && !(await isTradingDay(env, date))) closed.add(date)
  return closed
}

/** Evidence that the chain was being written before, from rows the caller already read: trading-day chains, any
 * row in the 14-day history (X−1..X live plus the memoized ended days); week / month, a row of X or of the
 * previous period (the state read). Without it, a date with no row is a chain not started yet (go-live, a new
 * chain), never missed. Limit: a chain silent for longer than the lookback stops raising missed. */
export function chainHistoryAvailable(dates: ChainDates, rows: ChainStateRow[], history: ChainHistoryRow[]): boolean {
  return dates.chain.period === 'trading_day' ? history.length > 0 : rows.length > 0
}

export async function chainAlerts(env: MonitoringEnv, dates: ChainDates, rows: ChainStateRow[], nowMs: number,
  historyAvailable: boolean, closedDates?: Set<string>): Promise<ChainAlert[]> {
  const out: ChainAlert[] = []
  const { chain } = dates
  const daily = isDaily(dates)
  // The stale-deadline rule is the daily chain's T+1 anchor only (contract: never for the week / month chains).
  const closed = closedDates ?? (daily ? await closedDeadlineDates(env, rows, dates.judged) : new Set<string>())
  for (const date of [dates.x, dates.xPrev]) {
    if (!date || !dates.judged.has(date)) continue
    const dayRows = rows.filter((row) => row.business_date === date)
    out.push(...judgeStageRows(dayRows, nowMs, closed, daily ? CHAIN_ROOT_STAGE : null))
    // No chain row at all after the first stage's deadline: daily, market-close-refresh (which pre-creates the
    // rows) never ran; the other chains, no stage of the trading day / period ever wrote (rows come with the first write).
    const deadline = twTimeOn(date, daily ? env.CHAIN_ROOT_EXPECTED_BY_TW ?? CHAIN_ROOT_DEADLINE_TW : chain.firstDeadlineTw)
    // Stalled repeating stage (intraday-check): it never runs or heartbeats, but its row is refreshed at least every
    // REPEAT_REFRESH_MIN_MS while results arrive; inside its schedule window an older updated_at is a stopped guard.
    const repeat = chain.repeat && dayRows.find((row) => row.stage_id === chain.repeat!.stageId)
    const windowEnd = chain.repeat ? twTimeOn(date, chain.repeat.windowEndTw) : null
    if (repeat && repeat.status !== 'pending' && deadline != null && windowEnd != null && nowMs >= deadline && nowMs < windowEnd
      && parse(repeat.updated_at) < nowMs - REPEAT_STALL_AFTER_MS) {
      out.push(alert(repeat, 'stuck', repeat.updated_at, nowMs))
    }
    if (!dayRows.length && historyAvailable && deadline != null && deadline < nowMs) {
      const since = new Date(deadline).toISOString()
      out.push({
        business_date: date, stage_id: chain.firstStage, kind: 'missed', severity: 'critical', status: 'absent', attempt: 0,
        expected_by: since, since, minutes: minutesSince(deadline, nowMs),
        summary: chain.period === 'trading_day' ? 'no chain rows for this trading day' : 'no chain rows for this period',
        error: null, root_ticket_id: null, ticket_id: null, run_id: null, execution_name: null,
      })
    }
  }
  const order = orderOf(chain.chainId)
  return out.sort((a, b) => b.business_date.localeCompare(a.business_date)
    || (order.get(a.stage_id) ?? 9999) - (order.get(b.stage_id) ?? 9999) || a.kind.localeCompare(b.kind))
}

function tradingDateSet(dates: BusinessDates): Set<string> {
  const set = new Set<string>()
  if (dates.xTrading) set.add(dates.x)
  if (dates.xPrev) set.add(dates.xPrev)
  return set
}

function historyWindow(dates: BusinessDates, days: number) {
  const span = Math.min(TIMELINE_MAX_DAYS, Math.max(1, Math.trunc(days) || TIMELINE_MAX_DAYS))
  const from = addDays(dates.x, -(span - 1))
  // X−1..X are still moving; everything before X−1 has ended.
  return { span, from, liveFrom: dates.xPrev && dates.xPrev > from ? dates.xPrev : from }
}

const byDateThenStageFor = (order: Map<string, number>) => (a: ChainHistoryRow, b: ChainHistoryRow) => a.business_date.localeCompare(b.business_date)
  || (order.get(a.stage_id) ?? 9999) - (order.get(b.stage_id) ?? 9999) || a.stage_id.localeCompare(b.stage_id)

/** The exact business dates a chain's history covers, ascending. Trading-day chains: the weekdays of
 * [X − days + 1, X] (no row is ever created on a weekend), X−1..X moving, the rest ended (hourly memo).
 * Week / month: the last N period keys, X moving, the rest ended (PERIOD_ENDED_TTL_S memo). */
function keyedHistoryPlan(dates: ChainDates, days: number) {
  const { chain } = dates
  if (chain.period === 'trading_day') {
    const { span, from, liveFrom } = historyWindow(dates, days)
    const all = Array.from({ length: span }, (_, index) => addDays(from, index))
      .filter((date) => { const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); return dow !== 0 && dow !== 6 })
    return { span, periods: null, from, ended: all.filter((date) => date < liveFrom), moving: all.filter((date) => date >= liveFrom), ttl: TIMELINE_HISTORY_TTL_S }
  }
  const keys = periodKeys(chain.chainId, dates.x, chain.historyPeriods).reverse()
  return { span: null, periods: keys.length, from: keys[0], ended: keys.slice(0, -1), moving: keys.slice(-1), ttl: PERIOD_ENDED_TTL_S }
}

async function readKeyed<T>(env: MonitoringEnv, sql: (count: number) => string, chainId: ChainId, keys: string[]): Promise<T[]> {
  if (!keys.length) return []
  return (await env.OPS_DB.prepare(sql(keys.length)).bind(...keys, chainId).all<T>()).results ?? []
}

/** Final stage states of [X − days + 1, X] (daily, intraday) or the last N periods (week, month), oldest first.
 * Ended dates come from the memo; the moving ones are `live` when the caller already read them (state / alerts),
 * else one more primary-key read. */
export async function readChainHistory(env: MonitoringEnv, dates: ChainDates, days: number, live?: ChainStateRow[]) {
  const { chainId } = dates.chain
  const plan = keyedHistoryPlan(dates, days)
  // v2: memo entries written before keyedHistorySql selected expected_by lack it.
  const ended = plan.ended.length
    ? await memoized(env.MEMO, `chain-history-v2|${chainId}|${plan.ended[0]}|${plan.ended.at(-1)}|${plan.ended.length}`, plan.ttl,
      () => readKeyed<ChainHistoryRow>(env, keyedHistorySql, chainId, plan.ended))
    : []
  const moving = live ? live.filter((row) => plan.moving.includes(row.business_date)) : await readKeyed<ChainHistoryRow>(env, keyedHistorySql, chainId, plan.moving)
  const rows = [...ended, ...moving].sort(byDateThenStageFor(orderOf(chainId)))
  // Truncation drops the oldest dates, never X.
  return { span: plan.span, periods: plan.periods, from: plan.from, truncated: rows.length > HISTORY_ROW_LIMIT, rows: rows.slice(-HISTORY_ROW_LIMIT) }
}

/** Business dates (ascending) on which each stage ended in error. */
function failedDates(history: ChainHistoryRow[]): Map<string, ChainHistoryRow[]> {
  const out = new Map<string, ChainHistoryRow[]>()
  for (const row of history) if (row.status === 'error') out.set(row.stage_id, [...(out.get(row.stage_id) ?? []), row])
  return out
}

const TERMINAL = new Set<ChainStatus>(['success', 'error', 'skipped', 'blocked'])

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Taiwan midnight of a business date, epoch ms. */
const twMidnightMs = (date: string) => Date.parse(`${date}T00:00:00Z`) - TW_OFFSET_MS

/** What a date's ETA counts from. Daily: the chain-root start (the stages are event-chained after it). The other
 * chains' stages are each triggered by their own schedule: Taiwan midnight of the business date / period key. */
function etaAnchors(dates: ChainDates, history: ChainHistoryRow[]): Map<string, number> {
  const out = new Map<string, number>()
  if (!isDaily(dates)) {
    for (const row of history) out.set(row.business_date, twMidnightMs(row.business_date))
    return out
  }
  for (const row of history) if (row.stage_id === CHAIN_ROOT_STAGE && Number.isFinite(parse(row.started_at))) out.set(row.business_date, parse(row.started_at))
  return out
}

/** Per stage: the median minutes from a day's ETA anchor to the stage's success, over the other days. */
function typicalDoneOffsets(history: ChainHistoryRow[], exceptDate: string, rootStart: Map<string, number>): Map<string, number> {
  const samples = new Map<string, number[]>()
  for (const row of history) {
    const start = rootStart.get(row.business_date)
    const done = parse(row.completed_at)
    if (row.business_date === exceptDate || row.status !== 'success' || start == null || !Number.isFinite(done) || done < start) continue
    samples.set(row.stage_id, [...(samples.get(row.stage_id) ?? []), (done - start) / 60_000])
  }
  const out = new Map<string, number>()
  for (const [stage, values] of samples) if (values.length >= ETA_MIN_SAMPLES) out.set(stage, Math.round(median(values)))
  return out
}

type StageEta = { typical_done_offset_min: number | null; eta: string | null; eta_margin_min: number | null; at_risk: boolean }

/** When a stage that has not ended should finish: its day's root start plus the typical offset, never earlier
 * than now nor than the dispatch it waits for. At risk = that is past expected_by (a deadline on a closed date is
 * stale and gives no margin). A watcher has no finishing time (its completed_at is its last result): no ETA. */
function stageEta(row: ChainStateRow, rootStartMs: number, typical: number | undefined, nowMs: number, closed: Set<string>, trading: boolean): StageEta {
  if (isWatcherStage(row.chain_id, row.stage_id)) return { typical_done_offset_min: null, eta: null, eta_margin_min: null, at_risk: false }
  const offset = typical ?? null
  if (offset == null || !Number.isFinite(rootStartMs) || TERMINAL.has(row.status)) {
    return { typical_done_offset_min: offset, eta: null, eta_margin_min: null, at_risk: false }
  }
  const waitUntil = parse(stageWait(row, nowMs).wait_until)
  const etaMs = Math.max(rootStartMs + offset * 60_000, nowMs, Number.isFinite(waitUntil) ? waitUntil : nowMs)
  const expected = parse(row.expected_by)
  const margin = Number.isFinite(expected) && !closed.has(twDateOf(row.expected_by) ?? '') ? Math.round((expected - etaMs) / 60_000) : null
  return {
    typical_done_offset_min: offset, eta: new Date(etaMs).toISOString(), eta_margin_min: margin,
    at_risk: trading && Number(row.optional) !== 1 && margin != null && margin < 0,
  }
}

/** A card's status in the state rows' vocabulary (a card that has not started or has no record is pending). */
const CARD_STATUS: Record<SchedulerJob['lastStatus'], ChainStatus> = {
  success: 'success', failed: 'error', blocked: 'blocked', running: 'running', skip: 'skipped', waiting: 'pending', sleep: 'pending',
}

/** The one value a node is coloured by: failed > overdue > stuck > blocked > at risk > waiting (parked on a scheduled
 * dispatch by design), else the DAG's visual status. */
function displayStatus(alerts: AlertKind[], atRisk: boolean, visual: string, waiting = false): string {
  return (['failed', 'overdue', 'stuck', 'blocked'] as const).find((kind) => alerts.includes(kind)) ?? (atRisk ? 'at_risk' : waiting ? 'waiting' : visual)
}

/** The period chains' response fields; the daily chain's responses stay as they were. */
const periodFields = (dates: ChainDates) => (isDaily(dates) ? {} : { period: dates.chain.period })
const xTradingField = (dates: ChainDates) => (dates.chain.period === 'trading_day' ? dates.xTrading : null)

export async function chainStateReport(env: MonitoringEnv, nowMs: number, requested?: string | null, chainId: ChainId = CHAIN_ID) {
  const dates = await resolveChainDates(env, nowMs, chainId, requested)
  const daily = isDaily(dates)
  const order = orderOf(chainId)
  const scope = scopeById(dates.chain.scope)
  const stageOrder = stageOrderFor(order)
  const rows = (await readStateRows(env, dates)).sort(stageOrder)
  const closed = daily ? await closedDeadlineDates(env, rows, dates.judged) : new Set<string>()
  const history = (await readChainHistory(env, dates, TIMELINE_MAX_DAYS, rows)).rows
  const historyAvailable = chainHistoryAvailable(dates, rows, history)
  const alerts = await chainAlerts(env, dates, rows, nowMs, historyAvailable, closed)
  const anchors = etaAnchors(dates, history)
  // Sub-stage cards (daily only) hang off a parent state row: without any row there is nothing to read progress for.
  const progress = daily && rows.length ? await readStageProgress(env, dates) : new Map()
  const etas = new Map<string, StageEta>()
  const rootStarts = new Map<string, number>()
  const cards = new Map<string, SubStageCard[]>()
  const jobsByDate = new Map<string, Map<string, SchedulerJob>>()
  const shown = [dates.x, dates.xPrev].filter((date): date is string => Boolean(date))
  for (const date of shown) {
    const dayRows = rows.filter((row) => row.business_date === date)
    const typical = typicalDoneOffsets(history, date, anchors)
    // The chain's start: the daily root; for the other chains the earliest stage start of the date / period.
    const rootStart = daily ? parse(dayRows.find((row) => row.stage_id === CHAIN_ROOT_STAGE)?.started_at)
      : Math.min(...dayRows.map((row) => parse(row.started_at)).filter(Number.isFinite), Number.POSITIVE_INFINITY)
    rootStarts.set(date, Number.isFinite(rootStart) ? rootStart : Number.NaN)
    const anchor = daily ? rootStart : twMidnightMs(date)
    for (const row of dayRows) etas.set(`${date}|${row.stage_id}`, stageEta(row, anchor, typical.get(row.stage_id), nowMs, closed, dates.judged.has(date)))
    const jobs = new Map(dayRows.map((row) => [row.stage_id, stateRowJob(row)]))
    cards.set(date, daily ? subStageCards(jobs, progress.get(date), nowMs) : [])
    jobsByDate.set(date, jobs)
  }
  const kinds = new Map<string, AlertKind[]>()
  for (const item of alerts) {
    const key = `${item.business_date}|${item.stage_id}`
    kinds.set(key, [...(kinds.get(key) ?? []), item.kind])
  }
  // X is today's date on a trading day: until its root starts (18:10) it has no row and the chain in flight is X−1.
  const hasRows = (date: string | null) => Boolean(date) && rows.some((row) => row.business_date === date)
  const active = hasRows(dates.x) || !hasRows(dates.xPrev) ? dates.x : dates.xPrev!
  const current = shown.map((date) => {
    const dayRows = rows.filter((row) => row.business_date === date)
    // The panel's current stage is picked among the displayed nodes, cards included.
    const jobs = new Map(jobsByDate.get(date))
    for (const card of cards.get(date) ?? []) jobs.set(card.job.id, card.job)
    const stage = jobs.size ? currentStage(jobs, scope) : null
    // Counts, elapsed time and margins are over the catalog stages only, never the cards.
    const required = dayRows.filter((row) => Number(row.optional) !== 1)
    const rootStart = rootStarts.get(date) ?? Number.NaN
    // Elapsed: root start to the last finish once every required stage has ended, else to now.
    const ended = required.length > 0 && required.every((row) => TERMINAL.has(row.status))
    const lastDone = Math.max(...required.map((row) => parse(row.completed_at)).filter(Number.isFinite), Number.NEGATIVE_INFINITY)
    const until = ended && Number.isFinite(lastDone) ? lastDone : nowMs
    const worst = required
      .map((row) => ({ stage: row.stage_id, margin: TERMINAL.has(row.status) ? null : etas.get(`${date}|${row.stage_id}`)?.eta_margin_min ?? null }))
      .filter((item): item is { stage: string; margin: number } => item.margin != null)
      .sort((a, b) => a.margin - b.margin)[0]
    return {
      business_date: date, active: date === active, trading_day: tradingFlag(dates, date), stage_id: stage?.id ?? null, visual_status: stage?.status ?? null, cue: stage?.cue ?? null,
      required_total: required.length, required_done: required.filter((row) => row.status === 'success' || row.status === 'skipped').length,
      failed: dayRows.filter((row) => row.status === 'error').length,
      root_started_at: Number.isFinite(rootStart) ? new Date(rootStart).toISOString() : null,
      elapsed_min: Number.isFinite(rootStart) && until >= rootStart ? Math.floor((until - rootStart) / 60_000) : null,
      worst_margin_min: worst?.margin ?? null, worst_margin_stage: worst?.stage ?? null,
    }
  })
  const stageRows = rows.map((row) => {
    const job = stateRowJob(row)
    const key = `${row.business_date}|${row.stage_id}`
    const eta = etas.get(key)
    const visual = visualStatus(job)
    const wait = stageWait(row, nowMs)
    return {
      ...row, optional: Number(row.optional) === 1, trading_day: tradingFlag(dates, row.business_date),
      // watcher: expected_by is the first result's deadline, completed_at the last result (no deadline margin).
      watcher: isWatcherStage(row.chain_id, row.stage_id), waiting: wait.waiting, wait_until: wait.wait_until,
      label: STAGES[row.stage_id]?.label ?? row.stage_id,
      phase: (daily ? dailyPhaseForStage(row.stage_id) : chainPhaseForStage(chainId as Exclude<ChainId, 'daily_readiness'>, row.stage_id)) ?? null,
      position: order.get(row.stage_id) ?? null, visual_status: visual, status_label: statusLabel(job),
      alerts: kinds.get(key) ?? [],
      ...eta,
      sub_stage: false, parent_stage_id: null as string | null,
      // The panel shows the cards in place of their parent, and ml-predict not at all.
      display_position: order.get(row.stage_id) ?? null, active: row.business_date === active,
      display_status: displayStatus(kinds.get(key) ?? [], Boolean(eta?.at_risk), visual, wait.waiting),
    }
  })
  // One row per card, in the stage rows' shape. A card has no deadline, alert or ETA of its own.
  const cardRows = shown.flatMap((date) => (cards.get(date) ?? []).map((card) => {
    const parent = rows.find((row) => row.business_date === date && row.stage_id === card.parent_stage_id)!
    const { job } = card
    const visual = visualStatus(job)
    return {
      business_date: date, chain_id: parent.chain_id, stage_id: job.id, status: CARD_STATUS[job.lastStatus] ?? 'pending',
      optional: Number(parent.optional) === 1, expected_by: null, attempt: Number(parent.attempt ?? 0),
      root_ticket_id: parent.root_ticket_id, ticket_id: parent.ticket_id, run_id: card.run_id, execution_name: null,
      summary: job.summary, error: job.lastError ?? null, started_at: job.lastRunAt ?? null, completed_at: card.completed_at,
      heartbeat_at: null, updated_at: card.observed_at, trading_day: tradingFlag(dates, date),
      watcher: false, waiting: false, wait_until: null as string | null,
      label: job.name, phase: dailyPhaseForStage(job.id) ?? null, position: DAILY_ORDER.get(job.id) ?? null,
      visual_status: visual, status_label: statusLabel(job), alerts: [] as AlertKind[],
      typical_done_offset_min: null, eta: null, eta_margin_min: null, at_risk: false,
      sub_stage: true, parent_stage_id: card.parent_stage_id as string | null,
      display_position: DAILY_ORDER.get(job.id) ?? null, active: date === active,
      // The card functions mark a card's own failure as failed and an unreached card behind it as blocked.
      display_status: job.lastStatus === 'failed' ? 'failed' : visual,
    }
  }))
  return {
    business_date: dates.x, previous_business_date: dates.xPrev, x_trading_day: xTradingField(dates), chain_id: chainId, ...periodFields(dates),
    // false: no row in the lookback (a chain not started yet); a date without rows is then not missed.
    history_available: historyAvailable,
    active_business_date: active,
    current,
    rows: [...stageRows, ...cardRows].sort(stageOrder).map(withIsoStamps),
  }
}

type AlertCounts = { total: number; failed: number; overdue: number; stuck: number; missed: number; blocked: number }
const countAlerts = (alerts: ChainAlert[]): AlertCounts => {
  const count = (kind: AlertKind) => alerts.filter((item) => item.kind === kind).length
  return { total: alerts.length, failed: count('failed'), overdue: count('overdue'), stuck: count('stuck'), missed: count('missed'), blocked: count('blocked') }
}

/** One chain's alerts. failures_14d: business dates in the 14 days ending at X on which the stage ended in error —
 * for the week / month chains the periods keyed in those 14 days (X and X−7; X), all inside the state read. */
async function oneChainAlerts(env: MonitoringEnv, nowMs: number, requested: string | null | undefined, chainId: ChainId) {
  const dates = await resolveChainDates(env, nowMs, chainId, requested)
  const rows = await readStateRows(env, dates)
  const trading = dates.chain.period === 'trading_day'
  const history = trading ? (await readChainHistory(env, dates, TIMELINE_MAX_DAYS, rows)).rows : []
  const historyAvailable = chainHistoryAvailable(dates, rows, history)
  const alerts = await chainAlerts(env, dates, rows, nowMs, historyAvailable)
  const failed = failedDates(trading ? history
    : rows.filter((row) => row.business_date >= addDays(dates.x, -(TIMELINE_MAX_DAYS - 1)) && row.business_date <= dates.x))
  return { dates, alerts, historyAvailable, rows: alerts.map((item) => ({ ...item, failures_14d: failed.get(item.stage_id)?.length ?? 0 })) }
}

/** `chain` = one chain: that chain's alerts (daily_readiness: the original response). `chain` = 'all' (the default):
 * every chain in one response — `counts` totals all chains so the Grafana alert rules cover them unchanged,
 * `counts_by_chain` splits them, rows carry their chain_id; the business-date fields are the daily chain's. */
export async function chainAlertsReport(env: MonitoringEnv, nowMs: number, requested?: string | null, chain: ChainId | 'all' = CHAIN_ID) {
  if (chain !== 'all') {
    const { dates, alerts, rows, historyAvailable } = await oneChainAlerts(env, nowMs, requested, chain)
    return {
      business_date: dates.x, previous_business_date: dates.xPrev, x_trading_day: xTradingField(dates), chain_id: chain, ...periodFields(dates),
      history_available: historyAvailable,
      counts: countAlerts(alerts),
      rows,
    }
  }
  const each = []
  for (const id of CHAIN_IDS) each.push({ id, ...await oneChainAlerts(env, nowMs, requested, id) })
  const daily = each[0].dates
  return {
    business_date: daily.x, previous_business_date: daily.xPrev, x_trading_day: daily.xTrading, chain_id: 'all',
    counts: countAlerts(each.flatMap((item) => item.alerts)),
    counts_by_chain: Object.fromEntries(each.map((item) => [item.id, countAlerts(item.alerts)])),
    chains: each.map(({ id, dates, historyAvailable }) => ({ chain_id: id, period: dates.chain.period, business_date: dates.x,
      previous_business_date: dates.xPrev, history_available: historyAvailable })),
    rows: each.flatMap((item) => item.rows.map((row) => ({ chain_id: item.id, ...row }))),
  }
}

/** Taiwan midnight of a business date, for Grafana's time axis. */
const twMidnight = (date: string) => new Date(twMidnightMs(date)).toISOString()

/** The window fields of history / timeline: days for the trading-day chains, periods for the week / month chains. */
const windowFields = (dates: ChainDates, span: number | null, periods: number | null) =>
  (isDaily(dates) ? { days: span } : { days: span, period: dates.chain.period, periods })

export async function chainHistoryReport(env: MonitoringEnv, nowMs: number, days: number, requested?: string | null, chainId: ChainId = CHAIN_ID) {
  const dates = await resolveChainDates(env, nowMs, chainId, requested)
  const { span, periods, from, truncated, rows } = await readChainHistory(env, dates, days)
  const order = orderOf(chainId)
  const label = (stage: string) => STAGES[stage]?.label ?? stage
  const position = (stage: string) => order.get(stage) ?? null
  return {
    business_date: dates.x, from, to: dates.x, ...windowFields(dates, span, periods), chain_id: chainId, truncated,
    rows: rows.map((row) => ({
      time: twMidnight(row.business_date), business_date: row.business_date, stage_id: row.stage_id, label: label(row.stage_id),
      position: position(row.stage_id), optional: Number(row.optional) === 1, status: row.status, attempt: Number(row.attempt ?? 0),
      // A watcher's expected_by is its first result's deadline and completed_at its last result: no margin between them.
      watcher: isWatcherStage(chainId, row.stage_id),
      // A success that needed more than one attempt is shown apart from a first-attempt success.
      result: row.status === 'success' && Number(row.attempt ?? 0) > 1 ? 'retry_success' : row.status,
      // Deadline margin (expected_by − completed_at) and finishing time on ② page; isoStamp for Grafana's JSONata.
      started_at: isoStamp(row.started_at ?? null), completed_at: isoStamp(row.completed_at ?? null), expected_by: isoStamp(row.expected_by ?? null),
    })),
    repeat_failures: [...failedDates(rows)].map(([stage, failures]) => ({
      stage_id: stage, label: label(stage), failures: failures.length, repeat: failures.length >= 2,
      last_failed_date: failures.at(-1)!.business_date, last_error: failures.at(-1)!.error,
      dates: failures.map((row) => row.business_date).join(','),
    })).sort((a, b) => b.failures - a.failures || (position(a.stage_id) ?? 9999) - (position(b.stage_id) ?? 9999)),
  }
}

export async function chainTimelineReport(env: MonitoringEnv, nowMs: number, days: number, requested?: string | null, chainId: ChainId = CHAIN_ID) {
  const dates = await resolveChainDates(env, nowMs, chainId, requested)
  // Same exact keys as the history: ended dates / periods from the memo, the moving ones read again.
  const plan = keyedHistoryPlan(dates, days)
  const history = plan.ended.length
    ? await memoized(env.MEMO, `timeline-history|${chainId}|${plan.ended[0]}|${plan.ended.at(-1)}|${plan.ended.length}`, plan.ttl,
      () => readKeyed<Record<string, unknown>>(env, keyedTimelineSql, chainId, plan.ended))
    : []
  const rows = [...history, ...await readKeyed<Record<string, unknown>>(env, keyedTimelineSql, chainId, plan.moving)].sort(byTransition)
  return {
    business_date: dates.x, from: plan.from, to: dates.x, ...windowFields(dates, plan.span, plan.periods), chain_id: chainId,
    truncated: rows.length > TIMELINE_ROW_LIMIT,
    // Truncation drops the oldest dates, never X.
    rows: rows.slice(-TIMELINE_ROW_LIMIT).map(withIsoStamps).map((row) => ({ time: row.transition_at, ...row })),
  }
}
