/** Chain state endpoints over the P2 tables (p2p3_contract.md). Every read is a primary-key prefix seek:
 * business_date first, chain_id second. Judgments (failed / overdue / stuck / missed) are computed here;
 * Grafana only compares counts to thresholds. */
import { currentStage, scopeById, scopeDisplayStageIds, statusLabel, visualStatus, STAGES } from './judgment/executionChainDag'
import { dailyPhaseForStage } from './judgment/dailyReadinessPhases'
import type { SchedulerJob } from './judgment/schedulerJob'
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

function stageOrder(a: ChainStateRow, b: ChainStateRow): number {
  return b.business_date.localeCompare(a.business_date)
    || (DAILY_ORDER.get(a.stage_id) ?? 9999) - (DAILY_ORDER.get(b.stage_id) ?? 9999)
    || a.stage_id.localeCompare(b.stage_id)
}

export async function chainAlerts(env: MonitoringEnv, dates: BusinessDates, rows: ChainStateRow[], nowMs: number, tradingDates: Set<string>): Promise<ChainAlert[]> {
  const out: ChainAlert[] = []
  // Deadline dates that are not trading days (a handful of KV reads: the distinct Taiwan dates of expected_by).
  const deadlineDates = [...new Set(rows.map((row) => twDateOf(row.expected_by)).filter((date): date is string => Boolean(date)))]
  const closed = new Set<string>()
  for (const date of deadlineDates) if (!tradingDates.has(date) && !(await isTradingDay(env, date))) closed.add(date)
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

export async function chainStateReport(env: MonitoringEnv, nowMs: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const rows = (await readChainState(env, dates)).sort(stageOrder)
  const trading = tradingDateSet(dates)
  const alerts = await chainAlerts(env, dates, rows, nowMs, trading)
  const kinds = new Map<string, AlertKind[]>()
  for (const item of alerts) {
    const key = `${item.business_date}|${item.stage_id}`
    kinds.set(key, [...(kinds.get(key) ?? []), item.kind])
  }
  const current = [dates.x, dates.xPrev].filter((date): date is string => Boolean(date)).map((date) => {
    const jobs = new Map(rows.filter((row) => row.business_date === date).map((row) => [row.stage_id, stateRowJob(row)]))
    const stage = jobs.size ? currentStage(jobs, DAILY) : null
    return { business_date: date, trading_day: trading.has(date), stage_id: stage?.id ?? null, visual_status: stage?.status ?? null, cue: stage?.cue ?? null }
  })
  return {
    business_date: dates.x, previous_business_date: dates.xPrev, x_trading_day: dates.xTrading, chain_id: CHAIN_ID,
    current,
    rows: rows.map((row) => {
      const job = stateRowJob(row)
      return {
        ...row, optional: Number(row.optional) === 1, trading_day: trading.has(row.business_date),
        label: STAGES[row.stage_id]?.label ?? row.stage_id, phase: dailyPhaseForStage(row.stage_id) ?? null,
        position: DAILY_ORDER.get(row.stage_id) ?? null, visual_status: visualStatus(job), status_label: statusLabel(job),
        alerts: kinds.get(`${row.business_date}|${row.stage_id}`) ?? [],
      }
    }),
  }
}

export async function chainAlertsReport(env: MonitoringEnv, nowMs: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const rows = await readChainState(env, dates)
  const alerts = await chainAlerts(env, dates, rows, nowMs, tradingDateSet(dates))
  const count = (kind: AlertKind) => alerts.filter((item) => item.kind === kind).length
  return {
    business_date: dates.x, previous_business_date: dates.xPrev, x_trading_day: dates.xTrading, chain_id: CHAIN_ID,
    counts: { total: alerts.length, failed: count('failed'), overdue: count('overdue'), stuck: count('stuck'), missed: count('missed') },
    rows: alerts,
  }
}

export async function chainTimelineReport(env: MonitoringEnv, nowMs: number, days: number, requested?: string | null) {
  const dates = await resolveBusinessDates(env, nowMs, requested)
  const span = Math.min(TIMELINE_MAX_DAYS, Math.max(1, Math.trunc(days) || TIMELINE_MAX_DAYS))
  const from = addDays(dates.x, -(span - 1))
  const read = async (first: string, last: string) =>
    (await env.OPS_DB.prepare(TIMELINE_SQL).bind(first, last, CHAIN_ID).all<Record<string, unknown>>()).results ?? []
  const liveFrom = dates.xPrev && dates.xPrev > from ? dates.xPrev : from
  const history = liveFrom > from
    ? await memoized(env.MEMO, `timeline-history|${from}|${liveFrom}`, TIMELINE_HISTORY_TTL_S, () => read(from, addDays(liveFrom, -1)))
    : []
  const rows = [...history, ...await read(liveFrom, dates.x)].sort(byTransition)
  const truncated = rows.length > TIMELINE_ROW_LIMIT
  return {
    business_date: dates.x, from, to: dates.x, days: span, chain_id: CHAIN_ID, truncated,
    // Truncation drops the oldest dates, never X.
    rows: rows.slice(-TIMELINE_ROW_LIMIT).map((row) => ({ time: row.transition_at, ...row })),
  }
}
