import {
  loadLatestSchedulerRootTicket,
  updateSchedulerExecutionTicket,
  type SchedulerExecutionTicketRow,
} from './schedulerExecutionTickets'
import { logSchedulerResult } from './schedulerRunLogger'
import { nextTwTradingDate } from './schedulerPolicy'
import { expirePremarketWaitingExecution } from './pipelineStageLease'
import { premarketPublicationCutoff } from './premarketPublicationWindow'
import type { ReportDeliveryEnv } from './reportDeliveryChannel'
import { recordChainStage } from './opsChainStageState'

const REQUIRED_STAGES = [
  'pipeline_execution',
  'post_pipeline_chain',
  'verify_v2',
  'screener_v2',
  'post_verify_chain',
] as const

type RequiredStage = typeof REQUIRED_STAGES[number]

type StageRow = {
  stage: string
  canonical_run_id: string
  status: string
  cursor_key: string | null
}

type StrategyLearningClosureRow = {
  canonical_run_id: string
  producer_run_id: string | null
  status: string
  expected_candidates: number
  processed_candidates: number
  expected_decision_rows: number
  persisted_decision_rows: number
  production_authority_intent: number
  policy_closure_status: string
  policy_closure_reason?: string | null
  completed_at: string | null
}

type Active8ChildRow = SchedulerExecutionTicketRow & {
  snapshot_status: string | null
  snapshot_run_id: string | null
}

export type EveningChainRootClosureOutcome = {
  status: 'closed_success' | 'closed_error' | 'pending' | 'not_applicable'
  business_date: string
  canonical_run_id: string | null
  root_ticket_id: string | null
  blockers: string[]
  summary: string
  /** Set when the root was already terminal before this call; nothing was closed. */
  already_terminal?: boolean
}

function parseMetadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function resolveCanonicalRunId(
  db: D1Database,
  businessDate: string,
  expectedCanonicalRunId?: string,
): Promise<string | null> {
  const expected = String(expectedCanonicalRunId ?? '').trim()
  if (expected) return expected
  const row = await db.prepare(`
    SELECT canonical_run_id
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='pipeline_execution'
     LIMIT 1
  `).bind(businessDate).first<{ canonical_run_id?: string | null }>()
  return String(row?.canonical_run_id ?? '').trim() || null
}

async function loadActive8Child(
  db: D1Database,
  rootTicketId: string,
): Promise<Active8ChildRow | null> {
  return db.prepare(`
    SELECT active8.*,
           snapshot.status AS snapshot_status,
           snapshot.run_id AS snapshot_run_id
      FROM scheduler_execution_tickets_v1 active8
      LEFT JOIN scheduler_execution_tickets_v1 snapshot
        ON snapshot.ticket_id=active8.parent_ticket_id
       AND snapshot.root_ticket_id=active8.root_ticket_id
       AND snapshot.task='dataset-snapshot-export'
     WHERE active8.root_ticket_id=?
       AND active8.ticket_kind='logical_child'
       AND active8.task='active8-oof-daily'
       AND json_extract(active8.metadata_json, '$.origin')='dataset_snapshot_ready'
     ORDER BY active8.updated_at DESC, active8.ticket_id DESC
     LIMIT 1
  `).bind(rootTicketId).first<Active8ChildRow>()
}

function terminalFailure(status: string): boolean {
  return status === 'error' || status === 'blocked' || status === 'skipped'
}

export type EveningChainRootClosureInput = {
  businessDate: string
  canonicalRunId?: string
  /** Past the closure deadline: missing or pending work is final, so the root closes as error. */
  deadlineExceeded?: boolean
  runScope?: 'live_canonical' | 'historical_replay' | 'derived'
  /** Appended to a failed closure's summary, so the receipt and its alert name why the DAG ended. */
  closureReason?: string
}

export async function closeEveningChainRootIfComplete(
  db: D1Database,
  input: EveningChainRootClosureInput,
): Promise<EveningChainRootClosureOutcome> {
  const closure = await closeEveningChainRootOnce(db, input)
  // Chain stage state `evening-closure` (observability; never throws). An already-terminal root was
  // recorded when it closed.
  if ((closure.status === 'closed_success' || closure.status === 'closed_error') && !closure.already_terminal
    && input.runScope !== 'historical_replay') {
    await recordChainStage({ stageId: 'evening-closure', businessDate: closure.business_date,
      status: closure.status === 'closed_success' ? 'success' : 'error', rootTicketId: closure.root_ticket_id,
      ticketId: closure.root_ticket_id, runId: closure.canonical_run_id, summary: closure.summary,
      error: closure.blockers.join(',') || null })
  }
  return closure
}

async function closeEveningChainRootOnce(
  db: D1Database,
  input: EveningChainRootClosureInput,
): Promise<EveningChainRootClosureOutcome> {
  const businessDate = String(input.businessDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error(`evening_chain_root_closure_date_invalid:${businessDate}`)
  }
  const root = await loadLatestSchedulerRootTicket(db, {
    schedulerJobId: 'evening-chain',
    businessDate,
  })
  if (!root) {
    return {
      status: 'not_applicable',
      business_date: businessDate,
      canonical_run_id: null,
      root_ticket_id: null,
      blockers: ['evening_chain_physical_root_missing'],
      summary: `evening-chain durable root absent date=${businessDate}`,
    }
  }
  const canonicalRunId = await resolveCanonicalRunId(db, businessDate, input.canonicalRunId)
  const recoverableTerminalRoot = ['error', 'blocked'].includes(root.status)
    && Boolean(canonicalRunId)
  if (root.status === 'success' || (terminalFailure(root.status) && !recoverableTerminalRoot)) {
    return {
      status: root.status === 'success' ? 'closed_success' : 'closed_error',
      business_date: businessDate,
      canonical_run_id: canonicalRunId,
      root_ticket_id: root.ticket_id,
      blockers: root.status === 'success' ? [] : [root.last_error || `root_${root.status}`],
      summary: root.last_summary || `evening-chain durable root already ${root.status}`,
      already_terminal: true,
    }
  }

  const closeAtDeadline = async (
    blockers: string[],
    runId: string | null,
    guardRunId?: string,
  ): Promise<EveningChainRootClosureOutcome> => {
    const error = `root_closure_deadline_exceeded:${blockers.join(',')}`
    const summary = `evening-chain durable DAG failed date=${businessDate} run_id=${runId ?? 'missing'} ${error}`
    await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket_id,
      runId: root.run_id,
      status: 'error',
      authority: 'logical_child',
      summary,
      error,
      expectedPipelineCanonicalRunId: guardRunId,
    })
    return {
      status: 'closed_error', business_date: businessDate, canonical_run_id: runId,
      root_ticket_id: root.ticket_id, blockers, summary,
    }
  }

  if (!canonicalRunId) {
    if (input.deadlineExceeded) return closeAtDeadline(['pipeline_execution_canonical_run_id_missing'], null)
    return {
      status: 'pending',
      business_date: businessDate,
      canonical_run_id: null,
      root_ticket_id: root.ticket_id,
      blockers: ['pipeline_execution_canonical_run_id_missing'],
      summary: `evening-chain root pending date=${businessDate} blocker=pipeline_execution_canonical_run_id_missing`,
    }
  }

  const [stageResult, learning, active8] = await Promise.all([
    db.prepare(`
      SELECT stage, canonical_run_id, status, cursor_key
        FROM pipeline_stage_runs
       WHERE business_date=?
         AND stage IN ('pipeline_execution','post_pipeline_chain','verify_v2','screener_v2','post_verify_chain')
    `).bind(businessDate).all<StageRow>(),
    db.prepare(`
      SELECT canonical_run_id, producer_run_id, status,
             expected_candidates, processed_candidates,
             expected_decision_rows, persisted_decision_rows,
             production_authority_intent, policy_closure_status, policy_closure_reason, completed_at
        FROM strategy_learning_runs
       WHERE business_date=? AND canonical_run_id=?
       LIMIT 1
    `).bind(businessDate, canonicalRunId).first<StrategyLearningClosureRow>(),
    loadActive8Child(db, root.root_ticket_id),
  ])
  const stageByName = new Map(
    (stageResult.results ?? []).map((row) => [row.stage as RequiredStage, row]),
  )
  const execution = stageByName.get('pipeline_execution')
  if (!execution || execution.canonical_run_id !== canonicalRunId) {
    if (input.deadlineExceeded) {
      return closeAtDeadline([`pipeline_execution:${execution ? 'canonical_run_id_mismatch' : 'missing'}`], canonicalRunId)
    }
    return {
      status: 'pending', business_date: businessDate, canonical_run_id: canonicalRunId,
      root_ticket_id: root.ticket_id, blockers: ['pipeline_execution:canonical_run_id_mismatch'],
      summary: `evening-chain stale closure ignored date=${businessDate} run_id=${canonicalRunId}`,
    }
  }
  const blockers: string[] = []
  let terminalError = false
  for (const stage of REQUIRED_STAGES) {
    const row = stageByName.get(stage)
    if (!row) {
      blockers.push(`${stage}:missing`)
      continue
    }
    // screener_v2 is owned by the upstream indicator canonical run. Its
    // lineage into the pipeline is fenced by cursor_key -> producer_run_id
    // below; forcing its canonical ID to equal the pipeline ID deadlocks root closure.
    if (stage !== 'screener_v2' && row.canonical_run_id !== canonicalRunId) {
      blockers.push(`${stage}:canonical_run_id_mismatch`)
      // A previous attempt's terminal result cannot fail the active run.
      // Keep waiting until this stage is owned by the current canonical run.
      continue
    }
    if (row.status !== 'success') {
      blockers.push(`${stage}:${row.status}`)
      terminalError = terminalError || terminalFailure(row.status)
    }
  }

  if (!learning) {
    blockers.push('strategy_learning:missing')
  } else {
    if (learning.status !== 'success') {
      blockers.push(`strategy_learning:${learning.status}`)
      terminalError = terminalError || terminalFailure(learning.status)
    }
    if (!learning.completed_at) blockers.push('strategy_learning:completed_at_missing')
    if (Number(learning.processed_candidates) !== Number(learning.expected_candidates)) {
      blockers.push('strategy_learning:candidate_count_mismatch')
    }
    if (Number(learning.persisted_decision_rows) !== Number(learning.expected_decision_rows)) {
      blockers.push('strategy_learning:decision_row_count_mismatch')
    }
    const validPolicyClosure = learning.policy_closure_status === 'materialized'
      || (
        Number(learning.production_authority_intent) === 0
        && learning.policy_closure_status === 'evidence_only'
      )
    if (!validPolicyClosure) blockers.push('strategy_learning:policy_closure_invalid')
    const screener = stageByName.get('screener_v2')
    if (!screener?.cursor_key) {
      blockers.push('screener_v2:producer_run_id_missing')
    } else if (String(learning.producer_run_id ?? '') !== screener.cursor_key) {
      blockers.push('strategy_learning:screener_producer_lineage_mismatch')
    }
  }

  if (!active8) {
    blockers.push('active8_oof_daily:missing')
  } else {
    if (active8.status !== 'success') {
      blockers.push(`active8_oof_daily:${active8.status}`)
      terminalError = terminalError || terminalFailure(active8.status)
    }
    if (active8.snapshot_status !== 'success') {
      blockers.push(`dataset_snapshot_export:${active8.snapshot_status || 'missing'}`)
      terminalError = terminalError || terminalFailure(active8.snapshot_status || '')
    }
    const metadata = parseMetadata(active8.metadata_json)
    if (String(metadata.snapshot_run_id ?? '') !== String(active8.snapshot_run_id ?? '')) {
      blockers.push('active8_oof_daily:snapshot_run_id_lineage_mismatch')
    }
  }

  if (blockers.length > 0 && !terminalError) {
    if (input.deadlineExceeded) return closeAtDeadline(blockers, canonicalRunId, canonicalRunId)
    return {
      status: 'pending',
      business_date: businessDate,
      canonical_run_id: canonicalRunId,
      root_ticket_id: root.ticket_id,
      blockers,
      summary: `evening-chain root pending date=${businessDate} run_id=${canonicalRunId} blockers=${blockers.join(',')}`,
    }
  }

  const status = blockers.length === 0 ? 'success' : 'error'
  const historicalExclusion = learning?.policy_closure_reason?.match(/historical_excluded=\S+/)?.[0] ?? 'historical_excluded=none'
  const scope = input.runScope === 'historical_replay' ? ' run_scope=historical_replay' : ''
  const summary = blockers.length === 0
    ? `evening-chain durable DAG complete date=${businessDate} run_id=${canonicalRunId} stages=${REQUIRED_STAGES.length} strategy_learning=success dataset_snapshot=success active8_oof_daily=success ${historicalExclusion}${scope}`
    : `evening-chain durable DAG failed date=${businessDate} run_id=${canonicalRunId} blockers=${blockers.join(',')}${scope}`
      + (input.closureReason ? ` reason=${input.closureReason}` : '')
  await updateSchedulerExecutionTicket(db, {
    ticketId: root.ticket_id,
    runId: root.run_id,
    status,
    authority: 'logical_child',
    summary,
    error: blockers.length ? blockers.join(',') : undefined,
    recoverTerminalFailure: recoverableTerminalRoot && status === 'success',
    expectedPipelineCanonicalRunId: canonicalRunId,
  })
  return {
    status: status === 'success' ? 'closed_success' : 'closed_error',
    business_date: businessDate,
    canonical_run_id: canonicalRunId,
    root_ticket_id: root.ticket_id,
    blockers,
    summary,
  }
}

/**
 * Root closure plus its KV receipt. Both terminal outcomes are written, so KV evening-chain never stays
 * at an earlier 'running' after the durable root closed as error.
 */
export async function closeEveningChainRootAndLog(
  kv: KVNamespace,
  db: D1Database,
  input: EveningChainRootClosureInput & {
    attemptId?: string
    alertEnv?: ReportDeliveryEnv
    /** Defaults to true; a caller whose own outcome must not hinge on the receipt passes false. */
    strict?: boolean
    supersedePrevious?: boolean
  },
): Promise<EveningChainRootClosureOutcome> {
  const closure = await closeEveningChainRootIfComplete(db, input)
  // An already-failed (or skipped) root was reported when it closed; re-sending it as error could replace a
  // same-run success receipt. An already-successful root may re-send its success (receipt recovery).
  if (closure.status === 'closed_success' || (closure.status === 'closed_error' && !closure.already_terminal)) {
    await logSchedulerResult(kv, 'evening-chain', {
      status: closure.status === 'closed_success' ? 'success' : 'error',
      summary: closure.summary,
      error: closure.blockers.length ? closure.blockers.join(',') : undefined,
      duration_ms: 0,
      run_id: closure.canonical_run_id ?? input.canonicalRunId,
      attempt_id: input.attemptId,
      run_date: closure.business_date,
      run_scope: input.runScope,
      strict: input.strict ?? true,
      supersedePrevious: input.supersedePrevious,
    }, input.alertEnv)
  }
  return closure
}

/**
 * A root can no longer complete on its own once this many TW trading days have passed after its business
 * date (the strategy-learning watchdog closes Friday's root on Monday night; long closures do not count).
 */
export const EVENING_CHAIN_ROOT_DEADLINE_TRADING_DAYS = 3
// Calendar pre-filter for the SQL candidate scan; the trading-day deadline decides.
const EVENING_CHAIN_ROOT_SWEEP_MIN_CALENDAR_DAYS = 4
// A pipeline execution parked as waiting (premarket resume, Modal callback) keeps its root open this long.
const EVENING_CHAIN_ROOT_WAITING_GRACE_DAYS = 14
const EVENING_CHAIN_ROOT_SWEEP_LOOKBACK_DAYS = 30
const EVENING_CHAIN_ROOT_SWEEP_LIMIT = 10
const EVENING_CHAIN_ROOT_SWEEP_MARKER_TTL_SECONDS = 2 * 86400

function calendarDaysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400_000).toISOString().slice(0, 10)
}

async function rootDeadlinePassed(kv: KVNamespace, businessDate: string, today: string): Promise<boolean> {
  let deadline = businessDate
  try {
    for (let day = 0; day < EVENING_CHAIN_ROOT_DEADLINE_TRADING_DAYS; day += 1) {
      deadline = await nextTwTradingDate(kv, deadline)
    }
  } catch (error) {
    console.warn(`[eveningChainRootClosure] trading calendar unresolved after ${businessDate}; root kept open:`, error)
    return false
  }
  return today > deadline
}

/**
 * Close physical roots whose newest ticket is still non-terminal past the deadline (for example a
 * postclose dispatch that failed before any stage existed). Recent roots, any date with a live stage
 * lease, and a pipeline execution parked as waiting for up to 14 calendar days are left to their owners.
 */
export async function sweepExpiredEveningChainRoots(
  kv: KVNamespace,
  db: D1Database,
  today: string,
): Promise<EveningChainRootClosureOutcome[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`evening_chain_root_sweep_date_invalid:${today}`)
  const { results } = await db.prepare(`
    SELECT DISTINCT t.business_date
      FROM scheduler_execution_tickets_v1 t
     WHERE t.scheduler_job_id='evening-chain' AND t.ticket_kind='physical_root'
       AND t.business_date BETWEEN ? AND ?
       AND t.status NOT IN ('success','error','skipped','blocked')
       AND NOT EXISTS (
         SELECT 1 FROM scheduler_execution_tickets_v1 n
          WHERE n.scheduler_job_id=t.scheduler_job_id AND n.business_date=t.business_date
            AND n.ticket_kind='physical_root'
            AND (n.updated_at>t.updated_at OR (n.updated_at=t.updated_at AND n.ticket_id>t.ticket_id)))
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_stage_runs s
          WHERE s.business_date=t.business_date
            AND ((s.stage='pipeline_execution' AND s.status='waiting' AND t.business_date>=?)
              OR (s.lease_owner IS NOT NULL AND s.lease_expires_at>=CURRENT_TIMESTAMP)))
     ORDER BY t.business_date
     LIMIT ?
  `).bind(
    calendarDaysBefore(today, EVENING_CHAIN_ROOT_SWEEP_LOOKBACK_DAYS),
    calendarDaysBefore(today, EVENING_CHAIN_ROOT_SWEEP_MIN_CALENDAR_DAYS),
    calendarDaysBefore(today, EVENING_CHAIN_ROOT_WAITING_GRACE_DAYS),
    EVENING_CHAIN_ROOT_SWEEP_LIMIT,
  ).all<{ business_date: string }>()
  const outcomes: EveningChainRootClosureOutcome[] = []
  for (const row of results ?? []) {
    if (!await rootDeadlinePassed(kv, row.business_date, today)) continue
    // Non-strict: the root is already terminal in D1 when the receipt is written, so a KV failure is
    // logged instead of aborting the sweep (a retry would no longer select this root).
    outcomes.push(await closeEveningChainRootAndLog(kv, db, {
      businessDate: row.business_date, deadlineExceeded: true, strict: false,
    }))
  }
  return outcomes
}

export const PREMARKET_RESUME_WINDOW_EXPIRED = 'premarket_resume_window_expired'

export type PremarketWaitingSettlement = {
  business_date: string
  canonical_run_id: string
  /** The session whose premarket was the only one allowed to resume this execution; null for a root-only retry. */
  resume_trade_date: string | null
  /**
   * closed: execution closed as error. kept_resumed: that premarket did resume (or its evidence is
   * unreadable), so a lost completion callback is not relabelled as an expired window. root_retry: the
   * execution was closed earlier and only its root was still open.
   */
  execution: 'closed' | 'kept_resumed' | 'root_retry'
  root: EveningChainRootClosureOutcome | null
}

export type PremarketWaitingSettlementOptions = {
  /** Market-domain DB: a past resume session counts only with its own FinLab 0050 bar. */
  marketDb?: D1Database
  nowMs?: number
  alertEnv?: ReportDeliveryEnv
  /**
   * Controller publication probe (premarket-state): true when the L4 serving publication of this exact
   * run exists. A throw keeps the execution waiting.
   */
  premarketPublished?: (input: { businessDate: string; canonicalRunId: string }) => Promise<boolean>
}

const TERMINAL_TICKET_STATUSES = ['success', 'error', 'skipped', 'blocked']

export const PREMARKET_RESUMED_CALLBACK_MISSING = 'premarket_resumed_completion_callback_missing'
export const PREMARKET_PUBLICATION_UNREADABLE = 'premarket_publication_unreadable'
/** Own task id: a kept wait is alerted without writing the evening-chain receipt as error while its root stays open. */
export const PREMARKET_WAIT_ALERT_TASK = 'evening-chain-premarket-wait'

/**
 * A kept wait still needs a human. Alerted through the scheduler receipt of its own task for the
 * execution's business date; an identical error receipt already there (7-day TTL) suppresses the nightly
 * repeat on top of the logger's 24h cron:alert dedup.
 */
async function alertKeptPremarketWait(
  kv: KVNamespace,
  row: { business_date: string; canonical_run_id: string },
  resumeTradeDate: string,
  reason: string,
  alertEnv?: ReportDeliveryEnv,
): Promise<void> {
  const error = `${reason}:resume_trade_date=${resumeTradeDate}`
  const previous = await kv.get(`scheduler:run:${PREMARKET_WAIT_ALERT_TASK}:${row.business_date}`, 'json')
    .catch(() => null) as { status?: string; error?: string; run_id?: string } | null
  if (previous?.status === 'error' && previous.error === error && previous.run_id === row.canonical_run_id) return
  await logSchedulerResult(kv, PREMARKET_WAIT_ALERT_TASK, {
    status: 'error',
    summary: `pipeline_execution kept waiting date=${row.business_date} run_id=${row.canonical_run_id} reason=${error}; `
      + 'premarket window passed, execution not closed, manual reconciliation required',
    error,
    duration_ms: 0,
    run_id: row.canonical_run_id,
    run_date: row.business_date,
    strict: false,
  }, alertEnv)
}

/** Any successful allocate/publish stage of that session that names this run means the resume happened. */
async function premarketResumeObserved(
  db: D1Database,
  resumeTradeDate: string,
  canonicalRunId: string,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS resumed
      FROM pipeline_stage_runs
     WHERE business_date=? AND canonical_run_id=?
       AND (stage='premarket_v3:allocate' OR stage LIKE 'premarket_v3:publish:%')
       AND status='success' AND instr(COALESCE(cursor_key,''), ?)>0
     LIMIT 1
  `).bind(resumeTradeDate, `${resumeTradeDate}:premarket-v3`, canonicalRunId).first<{ resumed?: number }>()
  return Number(row?.resumed ?? 0) === 1
}

/**
 * A pipeline execution parked as waiting/awaiting_premarket resumes only from the premarket of the next
 * TW session (premarket context reads the previous trading day; the controller refuses a resume after the
 * publication cutoff). Once that session has ended without resuming it, nothing can: close the exact
 * parked run as error, then its latest non-terminal physical root, whose receipt carries the scheduler alert.
 * Fail-safe: the resume session must be strictly before `today` (past sessions are confirmed by the market
 * DB), so an execution waiting for today's or a later premarket is never selected; a date with a live stage
 * lease is left alone; a resumed run whose completion callback is missing is kept, not relabelled.
 * Each date settles independently; failures are collected and thrown after the loop.
 */
export async function settleExpiredPremarketWaitingExecutions(
  kv: KVNamespace,
  db: D1Database,
  today: string,
  options: PremarketWaitingSettlementOptions = {},
): Promise<PremarketWaitingSettlement[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`premarket_waiting_settlement_date_invalid:${today}`)
  const nowMs = options.nowMs ?? Date.now()
  const { results } = await db.prepare(`
    SELECT e.business_date, e.canonical_run_id, e.status
      FROM pipeline_stage_runs e
     WHERE e.stage='pipeline_execution'
       AND e.business_date BETWEEN ? AND ?
       AND ((e.status='waiting' AND e.last_error='awaiting_premarket')
         OR (e.status='error' AND e.last_error LIKE '${PREMARKET_RESUME_WINDOW_EXPIRED}%'
           AND EXISTS (
             SELECT 1 FROM scheduler_execution_tickets_v1 t
              WHERE t.scheduler_job_id='evening-chain' AND t.business_date=e.business_date
                AND t.ticket_kind='physical_root'
                AND t.status NOT IN ('success','error','skipped','blocked')
                AND NOT EXISTS (
                  SELECT 1 FROM scheduler_execution_tickets_v1 n
                   WHERE n.scheduler_job_id=t.scheduler_job_id AND n.business_date=t.business_date
                     AND n.ticket_kind='physical_root'
                     AND (n.updated_at>t.updated_at OR (n.updated_at=t.updated_at AND n.ticket_id>t.ticket_id))))))
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_stage_runs s
          WHERE s.business_date=e.business_date
            AND s.lease_owner IS NOT NULL AND s.lease_expires_at>=CURRENT_TIMESTAMP)
     ORDER BY e.business_date
     LIMIT ?
  `).bind(
    calendarDaysBefore(today, EVENING_CHAIN_ROOT_SWEEP_LOOKBACK_DAYS),
    calendarDaysBefore(today, 1),
    EVENING_CHAIN_ROOT_SWEEP_LIMIT,
  ).all<{ business_date: string; canonical_run_id: string; status: string }>()
  const settlements: PremarketWaitingSettlement[] = []
  const failures: string[] = []
  for (const row of results ?? []) {
    try {
      const settlement = await settlePremarketWaitingRow(kv, db, today, nowMs, row, options)
      if (settlement) settlements.push(settlement)
    } catch (error) {
      failures.push(`${row.business_date}:${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
    }
  }
  if (failures.length) throw new Error(`premarket_waiting_settlement_failed:${failures.join(';')}`)
  return settlements
}

async function settlePremarketWaitingRow(
  kv: KVNamespace,
  db: D1Database,
  today: string,
  nowMs: number,
  row: { business_date: string; canonical_run_id: string; status: string },
  options: PremarketWaitingSettlementOptions,
): Promise<PremarketWaitingSettlement | null> {
  const identity = { businessDate: row.business_date, canonicalRunId: row.canonical_run_id }
  let resumeTradeDate: string | null = null
  if (row.status === 'waiting') {
    try {
      resumeTradeDate = await nextTwTradingDate(kv, row.business_date, options.marketDb, { nowMs })
    } catch (error) {
      console.warn(`[eveningChainRootClosure] premarket resume session unresolved after ${row.business_date}; execution kept waiting:`, error)
      return null
    }
    if (!(resumeTradeDate < today && nowMs > premarketPublicationCutoff(resumeTradeDate))) return null
    let keptReason: string | null = await premarketResumeObserved(db, resumeTradeDate, row.canonical_run_id)
      ? PREMARKET_RESUMED_CALLBACK_MISSING
      : null
    if (!keptReason && options.premarketPublished) {
      try {
        if (await options.premarketPublished(identity)) keptReason = PREMARKET_RESUMED_CALLBACK_MISSING
      } catch (error) {
        console.warn(`[eveningChainRootClosure] premarket publication unreadable date=${row.business_date}; execution kept waiting:`, error)
        keptReason = PREMARKET_PUBLICATION_UNREADABLE
      }
    }
    if (keptReason) {
      await alertKeptPremarketWait(kv, row, resumeTradeDate, keptReason, options.alertEnv)
      return { business_date: row.business_date, canonical_run_id: row.canonical_run_id, resume_trade_date: resumeTradeDate, execution: 'kept_resumed', root: null }
    }
    const closed = await expirePremarketWaitingExecution(db, {
      ...identity,
      error: `${PREMARKET_RESUME_WINDOW_EXPIRED}:resume_trade_date=${resumeTradeDate}`,
    })
    if (!closed) return null
  }
  const root = await loadLatestSchedulerRootTicket(db, { schedulerJobId: 'evening-chain', businessDate: row.business_date })
  const rootOpen = Boolean(root) && !TERMINAL_TICKET_STATUSES.includes(String(root?.status))
  if (!resumeTradeDate && !rootOpen) return null
  return {
    business_date: row.business_date,
    canonical_run_id: row.canonical_run_id,
    resume_trade_date: resumeTradeDate,
    execution: resumeTradeDate ? 'closed' : 'root_retry',
    // Non-strict: the execution is already terminal, so a KV failure is logged, not rethrown. A terminal
    // root (an earlier dispatch failure) keeps its own error and receipt.
    root: rootOpen
      ? await closeEveningChainRootAndLog(kv, db, {
        ...identity,
        closureReason: resumeTradeDate
          ? `${PREMARKET_RESUME_WINDOW_EXPIRED}:resume_trade_date=${resumeTradeDate}`
          : PREMARKET_RESUME_WINDOW_EXPIRED,
        strict: false,
        alertEnv: options.alertEnv,
      })
      : null,
  }
}

/**
 * Runs the sweep at most once per TW day; a failed sweep is retried by the next caller tick. Expired
 * premarket waits settle first, so their roots close with that reason instead of the generic deadline.
 */
export async function runEveningChainRootDeadlineSweepOnce(
  kv: KVNamespace,
  db: D1Database,
  today: string,
  options: PremarketWaitingSettlementOptions = {},
): Promise<string> {
  const markerKey = `evening-chain:root-deadline-sweep:${today}`
  if (await kv.get(markerKey)) return `skipped: evening-chain root deadline sweep already ran date=${today}`
  let settlementError: unknown = null
  let settlements: PremarketWaitingSettlement[] = []
  try {
    settlements = await settleExpiredPremarketWaitingExecutions(kv, db, today, options)
  } catch (error) {
    settlementError = error
  }
  let outcomes: EveningChainRootClosureOutcome[]
  try {
    outcomes = await sweepExpiredEveningChainRoots(kv, db, today)
  } catch (error) {
    if (settlementError) console.warn('[eveningChainRootClosure] premarket waiting settlement failed:', settlementError)
    throw error
  }
  // No marker after a failed settlement: the next tick retries it (the root sweep is idempotent).
  if (settlementError) throw settlementError
  const summary = `evening-chain root deadline sweep date=${today} closed=${outcomes.length}`
    + (outcomes.length ? ` dates=${outcomes.map((row) => `${row.business_date}:${row.status}`).join(',')}` : '')
    + ` premarket_wait_settled=${settlements.length}`
    + (settlements.length
      ? ` waits=${settlements.map((row) => `${row.business_date}:execution_${row.execution}:root_${row.root?.status ?? 'untouched'}`).join(',')}`
      : '')
  await kv.put(markerKey, summary, { expirationTtl: EVENING_CHAIN_ROOT_SWEEP_MARKER_TTL_SECONDS })
  return summary
}
