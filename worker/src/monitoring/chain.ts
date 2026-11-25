/** Chain state endpoints over the P2 tables (p2p3_contract.md). Every read is a primary-key prefix seek:
 * business_date first, chain_id second. Judgments (failed / overdue / stuck / missed, the active business date,
 * the status a node is coloured by) are computed here; Grafana only compares counts to thresholds.
 * /v1/chain/state also carries the FinLab and pipeline sub-stage cards (chainSubStages.ts). */
import { currentStage, scopeById, scopeDisplayStageIds, statusLabel, visualStatus, STAGES } from './judgment/executionChainDag'
import { dailyPhaseForStage } from './judgment/dailyReadinessPhases'
import type { SchedulerJob } from './judgment/schedulerJob'
import { readStageProgress, subStageCards, type SubStageCard } from './chainSubStages'
import { addDays, memoized, TW_OFFSET_MS, type MonitoringEnv } from './env'
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

export const TIMELINE_SQL = `SELECT business_date, stage_id, transition_at, to_status, from_status, attempt, ticket_id, run_id, summary
  FROM ops_chain_stage_transitions_v1
 WHERE business_date >= ? AND business_date <= ? AND chain_id = ?
 ORDER BY business_date DESC
 LIMIT ${TIMELINE_ROW_LIMIT + 1}`
// ORDER BY business_date alone is a reverse primary-key walk (no temp B-tree), so a truncation drops the
// oldest dates, never X. A full ORDER BY adds a temp B-tree that D1 bills as a second read of every row
// (measured: 300 rows → rows_read 601); the finer order is applied in JS.
export const HISTORY_SQL = `SELECT business_date, stage_id, status, optional, attempt, error, started_at, completed_at
  FROM ops_chain_stage_state_v1
 WHERE business_date >= ? AND business_date <= ? AND chain_id = ?
 ORDER BY business_date DESC
 LIMIT ${HISTORY_ROW_LIMIT + 1}`

export type ChainHistoryRow = Pick<ChainStateRow, 'business_date' | 'stage_id' | 'status' | 'optional' | 'attempt' | 'error' | 'started_at' | 'completed_at'>

const byTransition = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a.business_date).localeCompare(String(b.business_date)) || String(a.stage_id).localeCompare(String(b.stage_id))
  || String(a.transition_at).localeCompare(String(b.transition_at))

export type AlertKind = 'failed' | 'overdue' | 'stuck' | 'missed'

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
    status: row.status, attempt: Number(row.attempt ?? 0), expected_by: row.expected_by, since,
    minutes: minutesSince(parse(since), nowMs), summary: row.summary, error: row.error,
    root_ticket_id: row.root_ticket_id, ticket_id: row.ticket_id, run_id: row.run_id, execution_name: row.execution_name,
  }
}

/** Taiwan calendar date of an ISO instant. */
const twDateOf = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + TW_OFFSET_MS).toISOString().slice(0, 10) : null)

/** The contract's four rules for one trading day's rows. Callers pass only trading days (holidays: none).
 * `closedDeadlineDates`: Taiwan dates that are not trading days; a deadline on one is stale (T+1 closed after
 * pre-creation; P2 rewrites it when T's first premarket stage lands), so it raises no overdue. */
export function judgeStageRows(rows: ChainStateRow[], nowMs: number, closedDeadlineDates: Set<string> = new Set()): ChainAlert[] {
  const out: ChainAlert[] = []
  for (const row of rows) {
    // Failed: any error, optional stages included.
    if (row.status === 'error') out.push(alert(row, 'failed', row.completed_at ?? row.updated_at, nowMs))
    // Optional stages count only failures.
    if (Number(row.optional) === 1) continue
    const expected = parse(row.expected_by)
    const staleDeadline = closedDeadlineDates.has(twDateOf(row.expected_by) ?? '')
    if (Number.isFinite(expected) && expected < nowMs && !staleDeadline && row.status !== 'success' && row.status !== 'skipped') {
      out.push(alert(row, 'overdue', row.expected_by, nowMs))
    }
    // Stuck (contract 11/25): a stage that did heartbeat and then stopped for 15 minutes. Most stages write
    // running once and never heartbeat (overdue covers them); Cloud Run stages are GCP alerting's.
    if (row.status === 'running' && !row.execution_name && row.heartbeat_at && parse(row.heartbeat_at) < nowMs - STUCK_AFTER_MS) {
      out.push(alert(row, 'stuck', row.heartbeat_at, nowMs))
    }
    // Missed: the chain root never started after its deadline.
    if (row.stage_id === CHAIN_ROOT_STAGE && row.status === 'pending' && Number.isFinite(expected) && expected < nowMs) {
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

export async function readChainState(env: MonitoringEnv, dates: BusinessDates): Promise<ChainStateRow[]> {
  const result = await env.OPS_DB.prepare(STATE_SQL).bind(dates.x, dates.xPrev ?? dates.x, CHAIN_ID).all<ChainStateRow>()
  return result.results ?? []
}

const DAILY = scopeById('daily_readiness')
const DAILY_ORDER = new Map(scopeDisplayStageIds(DAILY).map((id, index) => [id, index]))

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

function stageOrder(a: StageKey, b: StageKey): number {
  return b.business_date.localeCompare(a.business_date)
    || (DAILY_ORDER.get(a.stage_id) ?? 9999) - (DAILY_ORDER.get(b.stage_id) ?? 9999)
    || a.stage_id.localeCompare(b.stage_id)
}

/** Deadline dates that are not trading days (a handful of KV reads: the distinct Taiwan dates of expected_by). */
async function closedDeadlineDates(env: MonitoringEnv, rows: ChainStateRow[], tradingDates: Set<string>): Promise<Set<string>> {
  const deadlineDates = [...new Set(rows.map((row) => twDateOf(row.expected_by)).filter((date): date is string => Boolean(date)))]
  const closed = new Set<string>()
  for (const date of deadlineDates) if (!tradingDates.has(date) && !(await isTradingDay(env, date))) closed.add(date)
  return closed
}

export async function chainAlerts(env: MonitoringEnv, dates: BusinessDates, rows: ChainStateRow[], nowMs: number, tradingDates: Set<string>,
  closedDates?: Set<string>): Promise<ChainAlert[]> {
  const out: ChainAlert[] = []
  const closed = closedDates ?? await closedDeadlineDates(env, rows, tradingDates)
  for (const date of [dates.x, dates.xPrev]) {
    if (!date || !tradingDates.has(date)) continue
    const dayRows = rows.filter((row) => row.business_date === date)
    out.push(...judgeStageRows(dayRows, nowMs, closed))
    // A trading day without any chain row: market-close-refresh (which pre-creates the rows) never ran.
    const deadline = twTimeOn(date, env.CHAIN_ROOT_EXPECTED_BY_TW ?? CHAIN_ROOT_DEADLINE_TW)
    if (!dayRows.length && deadline != null && deadline < nowMs) {
      const since = new Date(deadline).toISOString()
      out.push({
        business_date: date, stage_id: CHAIN_ROOT_STAGE, kind: 'missed', severity: 'critical', status: 'absent', attempt: 0,
        expected_by: since, since, minutes: minutesSince(deadline, nowMs), summary: 'no chain rows for this trading day',
        error: null, root_ticket_id: null, ticket_id: null, run_id: null, execution_name: null,
      })
    }
  }
  return out.sort((a, b) => b.business_date.localeCompare(a.business_date)
    || (DAILY_ORDER.get(a.stage_id) ?? 9999) - (DAILY_ORDER.get(b.stage_id) ?? 9999) || a.kind.localeCompare(b.kind))
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

const byDateThenStage = (a: ChainHistoryRow, b: ChainHistoryRow) => a.business_date.localeCompare(b.business_date)
  || (DAILY_ORDER.get(a.stage_id) ?? 9999) - (DAILY_ORDER.get(b.stage_id) ?? 9999) || a.stage_id.localeCompare(b.stage_id)

/** Final stage states of [X − days + 1, X], oldest first. Dates before X−1 come from the hourly memo; X−1..X are
 * `live` when the caller already read them (state / alerts), else one more primary-key range. */
export async function readChainHistory(env: MonitoringEnv, dates: BusinessDates, days: number, live?: ChainStateRow[]) {
  const { span, from, liveFrom } = historyWindow(dates, days)
  const read = async (first: string, last: string) =>
    (await env.OPS_DB.prepare(HISTORY_SQL).bind(first, last, CHAIN_ID).all<ChainHistoryRow>()).results ?? []
  const ended = liveFrom > from
    ? await memoized(env.MEMO, `chain-history|${from}|${liveFrom}`, TIMELINE_HISTORY_TTL_S, () => read(from, addDays(liveFrom, -1)))
    : []
  const moving = live ? live.filter((row) => row.business_date >= liveFrom && row.business_date <= dates.x) : await read(liveFrom, dates.x)
  const rows = [...ended, ...moving].sort(byDateThenStage)
  // Truncation drops the oldest dates, never X.
  return { span, from, truncated: rows.length > HISTORY_ROW_LIMIT, rows: rows.slice(-HISTORY_ROW_LIMIT) }
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

/** Per stage: the median minutes from a day's chain-root start to the stage's success, over the other days. */
function typicalDoneOffsets(history: ChainHistoryRow[], exceptDate: string): Map<string, number> {
  const rootStart = new Map<string, number>()
  for (const row of history) if (row.stage_id === CHAIN_ROOT_STAGE && Number.isFinite(parse(row.started_at))) rootStart.set(row.business_date, parse(row.started_at))
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
 * than now. At risk = that is past expected_by (a deadline on a closed date is stale and gives no margin). */
function stageEta(row: ChainStateRow, rootStartMs: number, typical: number | undefined, nowMs: number, closed: Set<string>, trading: boolean): StageEta {
  const offset = typical ?? null
  if (offset == null || !Number.isFinite(rootStartMs) || TERMINAL.has(row.status)) {
    return { typical_done_offset_min: offset, eta: null, eta_margin_min: null, at_risk: false }
  }
  const etaMs = Math.max(rootStartMs + offset * 60_000, nowMs)
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

/** The one value a node is coloured by: failed > overdue > stuck > at risk, else the DAG's visual status. */
function displayStatus(alerts: AlertKind[], atRisk: boolean, visual: string): string {
  return (['failed', 'overdue', 'stuck'] as const).find((kind) => alerts.includes(kind)) ?? (atRisk ? 'at_risk' : visual)
}

export async function chainStateReport(env: MonitoringEnv, nowMs: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const rows = (await readChainState(env, dates)).sort(stageOrder)
  const trading = tradingDateSet(dates)
  const closed = await closedDeadlineDates(env, rows, trading)
  const alerts = await chainAlerts(env, dates, rows, nowMs, trading, closed)
  const history = (await readChainHistory(env, dates, TIMELINE_MAX_DAYS, rows)).rows
  // Sub-stage cards hang off a parent state row: without any row there is nothing to read progress for.
  const progress = rows.length ? await readStageProgress(env, dates) : new Map()
  const etas = new Map<string, StageEta>()
  const rootStarts = new Map<string, number>()
  const cards = new Map<string, SubStageCard[]>()
  const jobsByDate = new Map<string, Map<string, SchedulerJob>>()
  const shown = [dates.x, dates.xPrev].filter((date): date is string => Boolean(date))
  for (const date of shown) {
    const dayRows = rows.filter((row) => row.business_date === date)
    const typical = typicalDoneOffsets(history, date)
    const rootStart = parse(dayRows.find((row) => row.stage_id === CHAIN_ROOT_STAGE)?.started_at)
    rootStarts.set(date, rootStart)
    for (const row of dayRows) etas.set(`${date}|${row.stage_id}`, stageEta(row, rootStart, typical.get(row.stage_id), nowMs, closed, trading.has(date)))
    const jobs = new Map(dayRows.map((row) => [row.stage_id, stateRowJob(row)]))
    cards.set(date, subStageCards(jobs, progress.get(date), nowMs))
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
    const stage = jobs.size ? currentStage(jobs, DAILY) : null
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
      business_date: date, active: date === active, trading_day: trading.has(date), stage_id: stage?.id ?? null, visual_status: stage?.status ?? null, cue: stage?.cue ?? null,
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
    return {
      ...row, optional: Number(row.optional) === 1, trading_day: trading.has(row.business_date),
      label: STAGES[row.stage_id]?.label ?? row.stage_id, phase: dailyPhaseForStage(row.stage_id) ?? null,
      position: DAILY_ORDER.get(row.stage_id) ?? null, visual_status: visual, status_label: statusLabel(job),
      alerts: kinds.get(key) ?? [],
      ...eta,
      sub_stage: false, parent_stage_id: null as string | null,
      // The panel shows the cards in place of their parent, and ml-predict not at all.
      display_position: DAILY_ORDER.get(row.stage_id) ?? null, active: row.business_date === active,
      display_status: displayStatus(kinds.get(key) ?? [], Boolean(eta?.at_risk), visual),
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
      heartbeat_at: null, updated_at: card.observed_at, trading_day: trading.has(date),
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
    business_date: dates.x, previous_business_date: dates.xPrev, x_trading_day: dates.xTrading, chain_id: CHAIN_ID,
    active_business_date: active,
    current,
    rows: [...stageRows, ...cardRows].sort(stageOrder).map(withIsoStamps),
  }
}

export async function chainAlertsReport(env: MonitoringEnv, nowMs: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const rows = await readChainState(env, dates)
  const alerts = await chainAlerts(env, dates, rows, nowMs, tradingDateSet(dates))
  const failed = failedDates((await readChainHistory(env, dates, TIMELINE_MAX_DAYS, rows)).rows)
  const count = (kind: AlertKind) => alerts.filter((item) => item.kind === kind).length
  return {
    business_date: dates.x, previous_business_date: dates.xPrev, x_trading_day: dates.xTrading, chain_id: CHAIN_ID,
    counts: { total: alerts.length, failed: count('failed'), overdue: count('overdue'), stuck: count('stuck'), missed: count('missed') },
    // failures_14d: business dates in the 14 days ending at X on which the stage ended in error.
    rows: alerts.map((item) => ({ ...item, failures_14d: failed.get(item.stage_id)?.length ?? 0 })),
  }
}

/** Taiwan midnight of a business date, for Grafana's time axis. */
const twMidnight = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - TW_OFFSET_MS).toISOString()

export async function chainHistoryReport(env: MonitoringEnv, nowMs: number, days: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const { span, from, truncated, rows } = await readChainHistory(env, dates, days)
  const label = (stage: string) => STAGES[stage]?.label ?? stage
  const position = (stage: string) => DAILY_ORDER.get(stage) ?? null
  return {
    business_date: dates.x, from, to: dates.x, days: span, chain_id: CHAIN_ID, truncated,
    rows: rows.map((row) => ({
      time: twMidnight(row.business_date), business_date: row.business_date, stage_id: row.stage_id, label: label(row.stage_id),
      position: position(row.stage_id), optional: Number(row.optional) === 1, status: row.status, attempt: Number(row.attempt ?? 0),
      // A success that needed more than one attempt is shown apart from a first-attempt success.
      result: row.status === 'success' && Number(row.attempt ?? 0) > 1 ? 'retry_success' : row.status,
    })),
    repeat_failures: [...failedDates(rows)].map(([stage, failures]) => ({
      stage_id: stage, label: label(stage), failures: failures.length, repeat: failures.length >= 2,
      last_failed_date: failures.at(-1)!.business_date, last_error: failures.at(-1)!.error,
      dates: failures.map((row) => row.business_date).join(','),
    })).sort((a, b) => b.failures - a.failures || (position(a.stage_id) ?? 9999) - (position(b.stage_id) ?? 9999)),
  }
}

export async function chainTimelineReport(env: MonitoringEnv, nowMs: number, days: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const { span, from, liveFrom } = historyWindow(dates, days)
  const read = async (first: string, last: string) =>
    (await env.OPS_DB.prepare(TIMELINE_SQL).bind(first, last, CHAIN_ID).all<Record<string, unknown>>()).results ?? []
  const history = liveFrom > from
    ? await memoized(env.MEMO, `timeline-history|${from}|${liveFrom}`, TIMELINE_HISTORY_TTL_S, () => read(from, addDays(liveFrom, -1)))
    : []
  const rows = [...history, ...await read(liveFrom, dates.x)].sort(byTransition)
  const truncated = rows.length > TIMELINE_ROW_LIMIT
  return {
    business_date: dates.x, from, to: dates.x, days: span, chain_id: CHAIN_ID, truncated,
    // Truncation drops the oldest dates, never X.
    rows: rows.slice(-TIMELINE_ROW_LIMIT).map(withIsoStamps).map((row) => ({ time: row.transition_at, ...row })),
  }
}
