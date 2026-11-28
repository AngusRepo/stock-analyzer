/** Reads of OPS_DB scheduler_execution_tickets_v1 (p4_sources.md §5, §6). Neither uses business_date IN (...):
 * there is no business_date-led index that serves it without reading every ticket of those days (~500 a day).
 * - /v1/chain/failure-classes: every non-success ticket since the window start by the status index, then the
 *   final ticket of each (job, date) by idx_scheduler_execution_tickets_job_date, and one class per (job, date).
 * - /v1/kv-drift: the nightly kv-config-drift task's own result (never re-run here: that needs the digest key).
 * No ORDER BY ... ticket_id DESC (a temp B-tree for the last term); sorting is in JS. */
import { schedulerTicketClosureDefect, type SchedulerExecutionTicketKind, type SchedulerExecutionTicketStatus } from '../lib/schedulerExecutionTickets'
import { classifySchedulerRunSummary } from '../lib/schedulerRunLogger'
import { addDays, twDate, type MonitoringEnv } from './env'
import { D1_OVERLOAD_MARKERS } from '../lib/d1CapacityErrors'

/** Step 1 cap: ~500 rows for 14 days today; a watchdog failing every 30 min adds 48 a day. */
export const FAILURE_TICKET_LIMIT = 1500
/** Step 2 seeks per request (~100 distinct (job, date) for 14 days today). */
export const FINAL_LOOKUP_LIMIT = 300
export const NON_SUCCESS_STATUSES = ['error', 'blocked', 'running', 'accepted', 'queued', 'triggered'] as const
/** An unsettled ticket older than this is an orphan. One conservative bound instead of schedulerStatus.runningSlaMs
 * per job group (20 min to 2 h), which is not exported: never a false orphan, a daily job shows late. */
const UNSETTLED_STALE_MS = 2 * 3600_000
const UNSETTLED_STALE_OVERRIDE_MS: Record<string, number> = {
  'active8-oof-monthly': 8 * 3600_000, 'monthly-strategy-mining': 4 * 3600_000, 'monthly-optuna': 4 * 3600_000, 'weekly-optuna': 3 * 3600_000,
}
export const KV_DRIFT_DAYS = 7
export const KV_DRIFT_JOB_ID = 'kv-config-drift'

const FAILURES_SQL = `SELECT ticket_id, scheduler_job_id, task, business_date, ticket_kind, status, status_authority, attempt_count,
       substr(last_error, 1, 300) AS last_error, substr(last_summary, 1, 300) AS last_summary,
       started_at, completed_at, updated_at
  FROM scheduler_execution_tickets_v1
 WHERE status IN (${NON_SUCCESS_STATUSES.map(() => '?').join(', ')}) AND business_date >= ?
 LIMIT ${FAILURE_TICKET_LIMIT}`
// loadLatestSchedulerRootTicket's shape, ORDER BY the index's own third column only.
const FINAL_SQL = `SELECT ticket_id, task, ticket_kind, status, attempt_count, scheduled_at, accepted_at,
       substr(last_error, 1, 300) AS last_error, substr(last_summary, 1, 300) AS last_summary, completed_at, updated_at
  FROM scheduler_execution_tickets_v1
 WHERE scheduler_job_id = ? AND business_date = ? ORDER BY updated_at DESC LIMIT 1`
const KV_DRIFT_SQL = `SELECT ticket_id, business_date, status, last_summary, last_error, completed_at, updated_at
  FROM scheduler_execution_tickets_v1 WHERE scheduler_job_id = ? AND business_date >= ?`

type Ticket = { ticket_id: string; scheduler_job_id: string | null; task: string; business_date: string; ticket_kind: SchedulerExecutionTicketKind
  status: SchedulerExecutionTicketStatus; status_authority: string; attempt_count: number; last_error: string | null; last_summary: string | null
  started_at: string | null; completed_at: string | null; updated_at: string }
export type FinalTicket = Pick<Ticket, 'ticket_id' | 'task' | 'ticket_kind' | 'status' | 'attempt_count' | 'last_error' | 'last_summary'
  | 'completed_at' | 'updated_at'> & { scheduled_at: string | null; accepted_at: string }

/** Dashboard classes (p4 §5): red final_failure, yellow recovered, purple orphan_running. */
export type FailureClass = 'final_failure' | 'upstream_blocked' | 'designed_retry' | 'recovered' | 'orphan_running'
  | 'unsettled_triggered' | 'in_progress'

/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) to epoch ms. */
const utcMs = (value: string | null | undefined) => value ? Date.parse(`${value.replace(' ', 'T')}${/Z|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z'}`) : NaN
const ticketText = (ticket: Pick<Ticket, 'last_error' | 'last_summary'>) => ticket.last_summary || ticket.last_error || ''
/** kv-config-drift results carry a 12-hex HMAC prefix per key; neither the failure list nor the drift page shows it. */
const withoutDigests = (text: string) => text.replace(/(=(?:match|drift|missing|invalid)):[0-9a-f]{12}/g, '$1')
const UPSTREAM_BLOCKED = /\bpipeline_blocked\b|\bstatus=blocked\b/i

/** One class for a (job, date) from its non-success tickets and its final ticket. Without a final ticket
 * (manual and logical-child tickets carry no scheduler_job_id) the newest non-success ticket stands in. */
export function classifyTicketGroup(tickets: Ticket[], final: FinalTicket | null, jobId: string | null, nowMs: number): FailureClass {
  const last = final ?? [...tickets].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  if (last.status === 'success' || last.status === 'skipped') {
    // reconcileSchedulerExecutionTicketStatus reads a closure defect as failed, not as the success it records.
    return final && schedulerTicketClosureDefect(final) ? 'final_failure' : 'recovered'
  }
  const text = ticketText(last)
  if (last.status === 'blocked' || UPSTREAM_BLOCKED.test(text)) return 'upstream_blocked'
  if (last.status === 'error') {
    const summaryClass = classifySchedulerRunSummary(text)
    // maintenance_lease_busy: and the other skip summaries are retries by design (schedulerRunLogger).
    return summaryClass === 'skipped' ? 'designed_retry' : summaryClass === 'blocked' ? 'upstream_blocked' : 'final_failure'
  }
  const stale = nowMs - utcMs(last.updated_at) > (UNSETTLED_STALE_OVERRIDE_MS[jobId ?? last.task] ?? UNSETTLED_STALE_MS)
  if (!stale || last.completed_at) return 'in_progress'
  // triggered/accepted/queued: some async roots never settle by design (p4 open question 8), so not an orphan.
  return last.status === 'running' ? 'orphan_running' : 'unsettled_triggered'
}

export async function failureClassesReport(env: MonitoringEnv, nowMs: number, days: number) {
  const today = twDate(nowMs)
  const since = addDays(today, -(days - 1))
  const db = env.OPS_DB
  const tickets = (await db.prepare(FAILURES_SQL).bind(...NON_SUCCESS_STATUSES, since).all<Ticket>()).results ?? []
  const groups = new Map<string, { jobId: string | null; task: string; date: string; tickets: Ticket[] }>()
  for (const ticket of tickets) {
    const key = `${ticket.scheduler_job_id ?? `task:${ticket.task}`}|${ticket.business_date}`
    const group = groups.get(key) ?? { jobId: ticket.scheduler_job_id, task: ticket.task, date: ticket.business_date, tickets: [] }
    group.tickets.push(ticket)
    groups.set(key, group)
  }
  const jobGroups = [...groups.values()].filter((group) => group.jobId)
  const lookups = jobGroups.slice(0, FINAL_LOOKUP_LIMIT)
  const finals = new Map<string, FinalTicket | null>()
  if (lookups.length) {
    const results = await db.batch<FinalTicket>(lookups.map((group) => db.prepare(FINAL_SQL).bind(group.jobId, group.date)))
    lookups.forEach((group, i) => finals.set(`${group.jobId}|${group.date}`, results[i].results?.[0] ?? null))
  }
  const rows = [...groups.entries()].map(([key, group]) => {
    const final = finals.get(key) ?? null
    const newest = [...group.tickets].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    const shown = final ?? newest
    const errorTicket = [...group.tickets].filter((ticket) => ticket.status === 'error').sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    return {
      business_date: group.date, job_id: group.jobId, task: group.task, ticket_kind: shown.ticket_kind,
      class: classifyTicketGroup(group.tickets, final, group.jobId, nowMs), final_status: shown.status, final_ticket_id: shown.ticket_id,
      final_known: final != null, non_success_tickets: group.tickets.length,
      error_tickets: group.tickets.filter((ticket) => ticket.status === 'error').length,
      detail: withoutDigests(ticketText(['error', 'blocked'].includes(shown.status) || !errorTicket ? shown : errorTicket)).slice(0, 300),
      updated_at: shown.updated_at, failure_occurrence: null as number | null, failure_days_in_window: 0,
    }
  })
  // 第幾次: the date's rank among the job's final-failure dates in the window, and the job's total.
  const failureDates = new Map<string, string[]>()
  for (const row of rows) {
    if (row.class !== 'final_failure') continue
    const job = row.job_id ?? `task:${row.task}`
    failureDates.set(job, [...(failureDates.get(job) ?? []), row.business_date])
  }
  for (const row of rows) {
    const dates = (failureDates.get(row.job_id ?? `task:${row.task}`) ?? []).sort()
    row.failure_days_in_window = new Set(dates).size
    if (row.class === 'final_failure') row.failure_occurrence = [...new Set(dates)].indexOf(row.business_date) + 1
  }
  rows.sort((a, b) => b.business_date.localeCompare(a.business_date) || String(a.job_id ?? a.task).localeCompare(String(b.job_id ?? b.task)))
  const classes: Record<FailureClass, number> = { final_failure: 0, upstream_blocked: 0, designed_retry: 0, recovered: 0,
    orphan_running: 0, unsettled_triggered: 0, in_progress: 0 }
  for (const row of rows) classes[row.class] += 1
  const byJob = new Map<string, { job_id: string | null; task: string; groups: number; final_failure_days: number; classes: Record<string, number> }>()
  for (const row of rows) {
    const key = row.job_id ?? `task:${row.task}`
    const job = byJob.get(key) ?? { job_id: row.job_id, task: row.task, groups: 0, final_failure_days: row.failure_days_in_window, classes: {} }
    job.groups += 1
    job.classes[row.class] = (job.classes[row.class] ?? 0) + 1
    byJob.set(key, job)
  }
  return {
    since, days, tickets_read: tickets.length, truncated: tickets.length >= FAILURE_TICKET_LIMIT,
    final_lookups: lookups.length, final_lookups_truncated: jobGroups.length > lookups.length,
    classes, rows,
    by_job: [...byJob.values()].sort((a, b) => b.final_failure_days - a.final_failure_days || b.groups - a.groups),
  }
}

/** kv_config_drift <key>=<match|drift|missing|invalid>[:<12-hex digest prefix>] ... | stored_risk_v2_drift ... failed=N
 * (kvConfigDigest.runKvConfigDriftCheck + the kv-config-drift task). The digest prefixes are dropped. */
export function parseKvDriftSummary(text: string) {
  const [kvPart, storedPart = ''] = text.replace(/^Error:\s*/, '').split(' | ')
  const keys = [...kvPart.matchAll(/(\S+)=(match|drift|missing|invalid)(?::[0-9a-f]{12})?/g)].map((match) => ({ key: match[1], status: match[2] }))
  const storedFailed = /\bstored_risk_v2_drift\b.*?\bfailed=(\d+)/.exec(storedPart)?.[1]
  return {
    keys,
    stored_risk_v2: storedPart.startsWith('stored_risk_v2_drift_error') ? 'error' : storedFailed == null ? null : Number(storedFailed) === 0 ? 'match' : 'drift',
    stored_risk_v2_failed: storedFailed == null ? null : Number(storedFailed),
    summary: withoutDigests(text).slice(0, 500),
  }
}

export async function kvDriftReport(env: MonitoringEnv, nowMs: number) {
  const since = addDays(twDate(nowMs), -(KV_DRIFT_DAYS - 1))
  const tickets = (await env.OPS_DB.prepare(KV_DRIFT_SQL).bind(KV_DRIFT_JOB_ID, since)
    .all<{ ticket_id: string; business_date: string; status: string; last_summary: string | null; last_error: string | null; completed_at: string | null; updated_at: string }>()).results ?? []
  const latestByDate = new Map<string, typeof tickets[number]>()
  for (const ticket of tickets) {
    const held = latestByDate.get(ticket.business_date)
    if (!held || ticket.updated_at > held.updated_at) latestByDate.set(ticket.business_date, ticket)
  }
  const rows = [...latestByDate.values()].sort((a, b) => b.business_date.localeCompare(a.business_date)).map((ticket) => {
    const parsed = parseKvDriftSummary(ticket.last_error || ticket.last_summary || '')
    const drifted = parsed.keys.filter((key) => key.status !== 'match').map((key) => key.key)
    return {
      business_date: ticket.business_date, status: ticket.status, completed_at: ticket.completed_at, updated_at: ticket.updated_at,
      // An unsettled ticket has no verdict yet; a finished one with no parsable keys is unknown, not a match.
      drift: ticket.status === 'running' || ticket.status === 'triggered' || ticket.status === 'accepted' || ticket.status === 'queued' ? null
        : parsed.keys.length ? drifted.length > 0 || parsed.stored_risk_v2 === 'drift' || parsed.stored_risk_v2 === 'error' : null,
      drifted_keys: drifted.join(','),
      ...Object.fromEntries(parsed.keys.map((key) => [key.key, key.status])),
      stored_risk_v2: parsed.stored_risk_v2, stored_risk_v2_failed: parsed.stored_risk_v2_failed, summary: parsed.summary,
    }
  })
  return { job_id: KV_DRIFT_JOB_ID, since, days: KV_DRIFT_DAYS, latest: rows[0] ?? null, rows }
}

/** /v1/d1/overloaded (v6 ①): scheduled tasks that ended on a D1 overload in the last 24 h. The error is already on
 * the ticket (last_error / last_summary), so nothing is written per request. One seek per (status, business_date) on
 * idx_scheduler_execution_tickets_status with updated_at as the range: only tickets updated in the 24 h are read. The
 * business dates run a week back (a watchdog may re-run an old date) to a weekend ahead (evening tickets carry the next
 * trading day). The match is instr() over the full columns in SQL (the text served is cut to 200 characters), with the
 * same marker strings as D1_OVERLOAD_MARKERS. Retries inside a task that later succeeded are not seen. */
export const D1_OVERLOAD_HOURS = 24
export const D1_OVERLOAD_DAYS_BACK = 7
export const D1_OVERLOAD_DAYS_AHEAD = 3
/** Cap on tickets read per request (error and blocked tickets updated in 24 h: ~50 on 11/26). */
export const D1_OVERLOAD_TICKET_LIMIT = 500
export { D1_OVERLOAD_MARKERS }
const overloadMatch = (column: string) => D1_OVERLOAD_MARKERS.map(() => `instr(IFNULL(${column}, ''), ?) > 0`).join(' OR ')
const d1OverloadSql = (dates: number) => `SELECT ticket_id, scheduler_job_id, task, business_date, status,
       substr(COALESCE(NULLIF(last_error, ''), last_summary), 1, 200) AS error, updated_at,
       (${overloadMatch('last_error')} OR ${overloadMatch('last_summary')}) AS overloaded
  FROM scheduler_execution_tickets_v1
 WHERE status IN ('error', 'blocked') AND business_date IN (${Array(dates).fill('?').join(', ')}) AND updated_at >= ?
 LIMIT ${D1_OVERLOAD_TICKET_LIMIT}`

export async function d1OverloadReport(env: MonitoringEnv, nowMs: number) {
  const sinceMs = nowMs - D1_OVERLOAD_HOURS * 3600_000
  const today = twDate(nowMs)
  const dates = Array.from({ length: D1_OVERLOAD_DAYS_BACK + D1_OVERLOAD_DAYS_AHEAD + 1 }, (_, i) => addDays(today, i - D1_OVERLOAD_DAYS_BACK))
  // updated_at is SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC).
  const since = new Date(sinceMs).toISOString().slice(0, 19).replace('T', ' ')
  const tickets = (await env.OPS_DB.prepare(d1OverloadSql(dates.length))
    .bind(...D1_OVERLOAD_MARKERS, ...D1_OVERLOAD_MARKERS, ...dates, since)
    .all<{ ticket_id: string; scheduler_job_id: string | null; task: string; business_date: string; status: string; error: string | null
      updated_at: string; overloaded: number }>()).results ?? []
  const rows = tickets.filter((ticket) => ticket.overloaded === 1)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((ticket) => ({ ticket_id: ticket.ticket_id, job_id: ticket.scheduler_job_id, task: ticket.task, business_date: ticket.business_date,
      status: ticket.status, error: ticket.error ?? '', updated_at: ticket.updated_at }))
  const byTask = new Map<string, { task: string; count: number; last_at: string }>()
  for (const row of rows) {
    const held = byTask.get(row.task) ?? { task: row.task, count: 0, last_at: row.updated_at }
    held.count += 1
    if (row.updated_at > held.last_at) held.last_at = row.updated_at
    byTask.set(row.task, held)
  }
  return {
    hours: D1_OVERLOAD_HOURS, since: new Date(sinceMs).toISOString(), tickets_read: tickets.length,
    truncated: tickets.length >= D1_OVERLOAD_TICKET_LIMIT,
    summary: { count: rows.length, tasks: byTask.size, last_at: rows[0]?.updated_at ?? null },
    by_task: [...byTask.values()].sort((a, b) => b.count - a.count || a.task.localeCompare(b.task)),
    rows,
  }
}
