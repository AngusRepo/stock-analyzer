import type { Bindings } from '../types'
import { controllerFetch, controllerJson, controllerPostJson } from './controllerClient'
import { invalidateModelPoolReadCache } from './modelPoolReadCache'
import { readCurrentExpectedReturnServingState, type ExpectedReturnOwner } from './expectedReturnServingState'
import { nextTwTradingDate } from './schedulerPolicy'
import { twToday } from './dateUtils'
import { strategyMiningDispatchKey } from './strategyMiningGateway'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadLatestSchedulerChildTicket, type SchedulerExecutionTicketRow } from './schedulerExecutionTickets'

function requireController(env: Bindings): void {
  if (!env.ML_CONTROLLER_URL) {
    throw new Error('ML_CONTROLLER_URL not set')
  }
}

export async function runWeeklyAudit(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/audit/weekly', {
    method: 'POST',
    timeoutMs: 120_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status !== 'success') return `failed: ${result.error ?? result.status}`

  if ((env as any).DISCORD_WEBHOOK_URL && result.report) {
    const { sendDiscordNotification } = await import('./notify')
    await sendDiscordNotification(
      (env as any).DISCORD_WEBHOOK_URL,
      `Weekly AI Audit Report (${result.report_date})\n\n${result.report}`.slice(0, 2000),
    )
  }

  return `report generated, return=${result.l1?.weekly_return ?? 'N/A'}`
}

type OptunaCadence = 'weekly' | 'monthly'

const OPTUNA_RESEARCH_SOURCES = [
  'barrier',
  'signal',
  'sltp',
  'screener',
  'conformal',
  'risk_params',
  'rrg',
  'alpha_framework',
  'ga_optimizer',
]

interface OptunaResearchOptions {
  cadence: OptunaCadence
  nTrials: number
  subsetSize: number
  runDate?: string
  schedulerTicketId?: string
  schedulerRunId?: string
  ga?: {
    populationSize: number
    generations: number
  }
}

function cleanText(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text && text !== 'unknown' && text !== 'undefined' && text !== 'null' ? text : undefined
}

function normalizeRemoteExecution(data: Record<string, any>): {
  backend: string
  executionId?: string
  executionName?: string
  functionCallId?: string
  runId?: string
  remoteExecutionId?: string
} {
  const backend = cleanText(data.backend) ?? (cleanText(data.function_call_id) ? 'modal' : 'cloud_run_job')
  const executionId = cleanText(data.execution_id)
  const executionName = cleanText(data.execution_name)
  const functionCallId = cleanText(data.function_call_id)
  const runId = cleanText(data.run_id)
  return {
    backend,
    executionId,
    executionName,
    functionCallId,
    runId,
    remoteExecutionId: cleanText(data.remote_execution_id) ?? executionId ?? functionCallId ?? runId,
  }
}

function buildOptunaSweepRequestBody(options: OptunaResearchOptions): Record<string, unknown> {
  return {
    cadence: options.cadence,
    n_trials: options.nTrials,
    subset_size: options.subsetSize,
    max_parallel_sources: 3,
    ga_population_size: options.ga?.populationSize ?? 24,
    ga_generations: options.ga?.generations ?? 8,
    sources: OPTUNA_RESEARCH_SOURCES,
    research_data_source: 'snapshot',
    evidence_requirement: 'requires compute snapshots',
    run_date: options.runDate,
    scheduler_ticket_id: options.schedulerTicketId,
    scheduler_run_id: options.schedulerRunId,
    push_kv: true,
    dry_run: false,
  }
}

function isInsufficientDataResponse(status: number, text: string): boolean {
  return status === 400 && /insufficient|no top stocks|benchmark/i.test(text)
}

async function runOptunaResearch(env: Bindings, options: OptunaResearchOptions) {
  requireController(env)

  const resp = await controllerFetch(env, '/optuna/research_sweep/run', {
    method: 'POST',
    jsonBody: buildOptunaSweepRequestBody(options),
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    if (isInsufficientDataResponse(resp.status, text)) {
      return `cadence=${options.cadence}, SKIPPED_NOT_READY(${text.slice(0, 300)})`
    }
    throw new Error(`${options.cadence} research sweep HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  const remote = normalizeRemoteExecution(data)
  const summary = [
    `optuna research Job triggered cadence=${options.cadence}`,
    `backend=${remote.backend}`,
    `remote_execution_id=${remote.remoteExecutionId ?? 'unknown'}`,
    `run_id=${remote.runId ?? 'unknown'}`,
    `execution_id=${remote.executionId ?? 'unknown'}`,
    'callback expected',
  ].join(' ')

  if ((env as any).DISCORD_WEBHOOK_URL) {
    const { sendDiscordNotification } = await import('./notify')
    await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL, `${options.cadence} Optuna research triggered\n${summary}`)
  }

  return `triggered ${summary}`
}

export async function runParameterCandidateValidationChain(
  env: Bindings,
  options: {
    cadence?: OptunaCadence | string
    runDate?: string
    runId?: string
    candidateIds?: string[]
    source?: string
    metadata?: Record<string, unknown>
  } = {},
) {
  requireController(env)
  const { ensureParameterCandidateTables } = await import('./parameterCandidateRegistry')
  await ensureParameterCandidateTables(databaseForDataDomain(env, 'learning'))

  const resp = await controllerFetch(env, '/config_pool/parameter_candidates/validation_chain/run', {
    method: 'POST',
    jsonBody: {
      cadence: options.cadence,
      run_date: options.runDate,
      run_id: options.runId,
      candidate_ids: options.candidateIds ?? [],
      source: options.source ?? 'optuna_callback',
      metadata: options.metadata ?? {},
      persist: true,
    },
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`parameter candidate validation HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status === 'failed' || result.status === 'error') {
    throw new Error(`parameter candidate validation failed: ${result.reason ?? result.error ?? result.status}`)
  }
  if (result.status === 'triggered') {
    return `triggered candidate_validation Job run_id=${result.run_id ?? options.runId ?? 'unknown'} execution_id=${result.execution_id ?? 'unknown'} callback expected`
  }
  const breakdown = result.status_breakdown && typeof result.status_breakdown === 'object'
    ? result.status_breakdown as Record<string, any>
    : {}
  return [
    `candidate_validation status=${result.status ?? 'completed'}`,
    `total=${result.total ?? 0}`,
    `ready=${result.ready ?? 0}`,
    `evidence_insufficient=${result.evidence_insufficient ?? breakdown.EVIDENCE_INSUFFICIENT ?? 0}`,
    `not_promotion_ready=${result.not_promotion_ready ?? breakdown.NOT_PROMOTION_READY ?? 0}`,
    `infra_blocked=${result.infra_blocked ?? result.blocked ?? breakdown.INFRA_BLOCKED ?? 0}`,
  ].join(' ')
}

export async function runGaProductionShadowDaily(
  env: Bindings,
  options: { runDate: string; runId: string },
): Promise<string> {
  requireController(env)
  const resp = await controllerFetch(env, '/optuna/ga_shadow/daily/run', {
    method: 'POST',
    jsonBody: {
      run_date: options.runDate,
      run_id: options.runId,
    },
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`GA shadow daily HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status !== 'triggered') {
    throw new Error(`GA shadow daily trigger invalid status=${result.status ?? 'missing'}`)
  }
  const remote = normalizeRemoteExecution(result)
  if (!remote.remoteExecutionId) {
    throw new Error('GA shadow daily trigger missing remote_execution_id')
  }
  return [
    'triggered GA frozen prospective shadow Job',
    `run_date=${options.runDate}`,
    `run_id=${options.runId}`,
    `remote_execution_id=${remote.remoteExecutionId}`,
    'production_effect=false',
    'callback expected',
  ].join(' ')
}

export async function runWeeklyOptunaResearch(
  env: Bindings,
  runDate?: string,
  schedulerContext: { schedulerTicketId?: string; schedulerRunId?: string } = {},
) {
  return runOptunaResearch(env, {
    cadence: 'weekly',
    nTrials: 80,
    subsetSize: 400,
    runDate,
    schedulerTicketId: schedulerContext.schedulerTicketId,
    schedulerRunId: schedulerContext.schedulerRunId,
    ga: {
      populationSize: 12,
      generations: 4,
    },
  })
}

export async function runMonthlyOptunaResearch(
  env: Bindings,
  runDate?: string,
  schedulerContext: { schedulerTicketId?: string; schedulerRunId?: string } = {},
) {
  return runOptunaResearch(env, {
    cadence: 'monthly',
    nTrials: 300,
    // Discovery stays broad in parameter space, but does not replay the full
    // universe for every trial. The successful composite is already sent to
    // parameter-candidate validation, which performs the full-universe replay.
    subsetSize: 400,
    runDate,
    schedulerTicketId: schedulerContext.schedulerTicketId,
    schedulerRunId: schedulerContext.schedulerRunId,
    ga: {
      populationSize: 36,
      generations: 12,
    },
  })
}

type Active8MarketSessionRow = {
  trading_date?: string | null
  price_rows?: number | string | null
}

type Active8ComputeSnapshotRow = {
  snapshot_id?: string | null
  business_date?: string | null
  metadata_json?: string | null
}

export type Active8DailySnapshotPreflight = {
  ready: boolean
  reason: 'ready' | 'market_session_calendar_missing' | 'market_session_coverage_incomplete'
    | 'exact_compute_snapshot_missing' | 'compute_snapshot_behind_market_session'
    | 'compute_snapshot_history_insufficient'
  cutoff: string
  expected_business_date: string | null
  snapshot_business_date: string | null
  snapshot_id: string | null
  snapshot_start_date?: string | null
  snapshot_minimum_start_date?: string | null
  market_session_coverage_reference: number | null
  market_session_coverage_threshold: number | null
  market_session_price_rows: number | null
}

type Active8DailyTerminalTicketEvidence = Pick<
  SchedulerExecutionTicketRow,
  'status' | 'business_date' | 'metadata_json'
>

const ACTIVE8_COMPUTE_SNAPSHOT_LOOKBACK_DAYS = 504

function active8SnapshotStartDate(snapshot: Active8ComputeSnapshotRow | null): string | null {
  if (!snapshot?.metadata_json) return null
  try {
    const metadata = JSON.parse(snapshot.metadata_json) as Record<string, unknown>
    const value = String(metadata.start_date ?? '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  } catch {
    return null
  }
}

function utcDateMinusDays(date: string, days: number): string | null {
  const parsed = new Date(date + 'T00:00:00.000Z')
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setUTCDate(parsed.getUTCDate() - days)
  return parsed.toISOString().slice(0, 10)
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

export function assessActive8DailySnapshotPreflight(
  cutoff: string,
  marketRows: Active8MarketSessionRow[],
  snapshot: Active8ComputeSnapshotRow | null,
): Active8DailySnapshotPreflight {
  const normalized = marketRows
    .map((row) => ({
      tradingDate: String(row.trading_date ?? '').slice(0, 10),
      priceRows: Math.max(0, Number(row.price_rows ?? 0)),
    }))
    .filter((row) => row.tradingDate && Number.isFinite(row.priceRows))
  const counts = normalized.map((row) => row.priceRows)
  if (!counts.length) {
    return {
      ready: false,
      reason: 'market_session_calendar_missing',
      cutoff,
      expected_business_date: null,
      snapshot_business_date: snapshot?.business_date?.slice(0, 10) ?? null,
      snapshot_id: snapshot?.snapshot_id ?? null,
      market_session_coverage_reference: null,
      market_session_coverage_threshold: null,
      market_session_price_rows: null,
    }
  }

  const reference = median(counts)
  const threshold = Math.max(100, Math.floor(reference * 0.20))
  const sessions = normalized.filter((row) => row.priceRows >= threshold)
  if (!sessions.length) {
    return {
      ready: false,
      reason: 'market_session_coverage_incomplete',
      cutoff,
      expected_business_date: null,
      snapshot_business_date: snapshot?.business_date?.slice(0, 10) ?? null,
      snapshot_id: snapshot?.snapshot_id ?? null,
      market_session_coverage_reference: reference,
      market_session_coverage_threshold: threshold,
      market_session_price_rows: null,
    }
  }

  const latestSession = sessions[sessions.length - 1]
  const snapshotBusinessDate = snapshot?.business_date?.slice(0, 10) ?? null
  const snapshotStartDate = active8SnapshotStartDate(snapshot)
  const snapshotMinimumStartDate = snapshotBusinessDate
    ? utcDateMinusDays(snapshotBusinessDate, ACTIVE8_COMPUTE_SNAPSHOT_LOOKBACK_DAYS)
    : null
  const base = {
    cutoff,
    expected_business_date: latestSession.tradingDate,
    snapshot_business_date: snapshotBusinessDate,
    snapshot_id: snapshot?.snapshot_id ?? null,
    snapshot_start_date: snapshotStartDate,
    snapshot_minimum_start_date: snapshotMinimumStartDate,
    market_session_coverage_reference: reference,
    market_session_coverage_threshold: threshold,
    market_session_price_rows: latestSession.priceRows,
  }
  if (!snapshotBusinessDate) {
    return { ...base, ready: false, reason: 'exact_compute_snapshot_missing' }
  }
  if (snapshotBusinessDate !== latestSession.tradingDate) {
    return { ...base, ready: false, reason: 'compute_snapshot_behind_market_session' }
  }
  if (!snapshotStartDate || !snapshotMinimumStartDate || snapshotStartDate > snapshotMinimumStartDate) {
    return { ...base, ready: false, reason: 'compute_snapshot_history_insufficient' }
  }
  return { ...base, ready: true, reason: 'ready' }
}

export function assessActive8DailyTerminalFence(
  preflight: Active8DailySnapshotPreflight,
  ticket: Active8DailyTerminalTicketEvidence | null,
): { closed: boolean; reason: string } {
  if (!preflight.ready || !preflight.snapshot_business_date || !preflight.snapshot_id) {
    return { closed: false, reason: 'snapshot_preflight_not_ready' }
  }
  if (!ticket) return { closed: false, reason: 'terminal_ticket_missing' }
  if (ticket.status !== 'success') {
    return { closed: false, reason: `terminal_ticket_${ticket.status}` }
  }
  if (ticket.business_date !== preflight.snapshot_business_date) {
    return { closed: false, reason: 'terminal_ticket_business_date_mismatch' }
  }

  let metadata: Record<string, unknown>
  try {
    metadata = JSON.parse(ticket.metadata_json || '{}') as Record<string, unknown>
  } catch {
    return { closed: false, reason: 'terminal_ticket_metadata_invalid' }
  }
  if (String(metadata.origin ?? '') !== 'dataset_snapshot_ready') {
    return { closed: false, reason: 'terminal_ticket_origin_mismatch' }
  }
  if (String(metadata.snapshot_id ?? '') !== preflight.snapshot_id) {
    return { closed: false, reason: 'terminal_ticket_snapshot_mismatch' }
  }
  return { closed: true, reason: 'exact_snapshot_terminal_success' }
}

async function loadActive8DailyTerminalTicket(
  env: Bindings,
  preflight: Active8DailySnapshotPreflight,
): Promise<SchedulerExecutionTicketRow | null> {
  if (!preflight.snapshot_business_date) return null
  return loadLatestSchedulerChildTicket(databaseForDataDomain(env, 'ops'), {
    task: 'active8-oof-daily',
    businessDate: preflight.snapshot_business_date,
    origin: 'dataset_snapshot_ready',
  })
}

async function inspectActive8DailySnapshotPreflight(
  env: Bindings,
  cutoff: string,
): Promise<Active8DailySnapshotPreflight> {
  const [marketResult, snapshot] = await Promise.all([
    databaseForDataDomain(env, 'market').prepare(`
      SELECT substr(date, 1, 10) AS trading_date, COUNT(*) AS price_rows
        FROM stock_prices
       WHERE substr(date, 1, 10) BETWEEN date(?, '-45 days') AND date(?)
       GROUP BY substr(date, 1, 10)
       ORDER BY trading_date
    `).bind(cutoff, cutoff).all<Active8MarketSessionRow>(),
    databaseForDataDomain(env, 'learning').prepare(`
      SELECT snapshot_id, business_date, metadata_json
        FROM dataset_snapshots
       WHERE kind='backtest_dataset'
         AND access_tier='compute'
         AND status='ready'
         AND business_date <= ?
       ORDER BY business_date DESC, created_at DESC
       LIMIT 1
    `).bind(cutoff).first<Active8ComputeSnapshotRow>(),
  ])
  return assessActive8DailySnapshotPreflight(cutoff, marketResult.results ?? [], snapshot)
}

export async function runActive8OofLifecycle(
  env: Bindings,
  runDate?: string,
  cadence: 'daily' | 'weekly' | 'monthly' = 'daily',
  options: {
    expectedCohortId?: string
    continuationAttempt?: number
    continuationOnly?: boolean
    schedulerTicketId?: string
    schedulerRunId?: string
  } = {},
) {
  requireController(env)

  if (cadence === 'daily' && options.continuationOnly !== true) {
    const cutoff = runDate || twToday()
    const preflight = await inspectActive8DailySnapshotPreflight(env, cutoff)
    if (preflight && !preflight.ready) {
      return [
        'active8_oof_lifecycle status=skipped',
        'cadence=daily',
        `reason=${preflight.reason}`,
        `expected_business_date=${preflight.expected_business_date ?? 'none'}`,
        `snapshot_business_date=${preflight.snapshot_business_date ?? 'none'}`,
        `snapshot_id=${preflight.snapshot_id ?? 'none'}`,
        'cloud_run_dispatched=false',
      ].join(' ')
    }
    const terminalTicket = await loadActive8DailyTerminalTicket(env, preflight)
    const terminalFence = assessActive8DailyTerminalFence(preflight, terminalTicket)
    if (terminalFence.closed) {
      return [
        'active8_oof_lifecycle status=idempotent_complete',
        'cadence=daily',
        'cohort=none',
        'promoted=false',
        `reason=${terminalFence.reason}`,
        `expected_business_date=${preflight.expected_business_date ?? 'none'}`,
        `snapshot_business_date=${preflight.snapshot_business_date ?? 'none'}`,
        `snapshot_id=${preflight.snapshot_id ?? 'none'}`,
        'cloud_run_dispatched=false',
      ].join(' ')
    }
  }

  const resp = await controllerFetch(env, '/walk_forward/oof/lifecycle', {
    method: 'POST',
    jsonBody: {
      cadence,
      end_date: runDate,
      dry_run: false,
      // Only the daily exact-candidate forward evaluator may promote.
      // Weekly/monthly runs generate immutable candidates and must never
      // mutate production pointers, including their first (non-continuation) call.
      promote: cadence === 'daily',
      dispatch_full_fit: cadence !== 'daily',
      expected_cohort_id: options.expectedCohortId,
      continuation_attempt: Math.max(0, Math.min(12, Number(options.continuationAttempt ?? 0))),
      continuation_only: options.continuationOnly === true,
      scheduler_ticket_id: options.schedulerTicketId,
      scheduler_run_id: options.schedulerRunId,
    },
    // The controller only dispatches a durable Cloud Run Job. The terminal
    // result arrives through /api/admin/scheduler-callback.
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`Active-8 OOF lifecycle HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  const status = String(data.status ?? '').toLowerCase()
  if (!['skipped', 'pending', 'spawned', 'materialized', 'shadow_evaluated', 'idempotent_complete'].includes(status)) {
    throw new Error(`Active-8 OOF lifecycle unexpected status=${status || 'unknown'}`)
  }
  if (
    status === 'pending'
    && String(data.reason ?? '') === 'materialization_job_active'
    && options.schedulerTicketId
    && options.schedulerRunId
    && options.continuationAttempt == null
  ) {
    await env.UPDATE_QUEUE.send({
      type: 'active8_oof_continuation',
      cursor: 0,
      triggerTime: runDate || twToday(),
      runId: options.schedulerRunId,
      schedulerTicketId: options.schedulerTicketId,
      schedulerRunId: options.schedulerRunId,
      oofCadence: cadence,
      oofExpectedCohortId: cleanText(data.cohort_id),
      oofContinuationAttempt: 1,
    }, { delaySeconds: 300 })
  }
  return [
    `active8_oof_lifecycle status=${status}`,
    `cadence=${cadence}`,
    `cohort=${data.cohort_id ?? 'none'}`,
    `promoted=${Boolean(data.promoted)}`,
    `reason=${data.promotion_reason ?? data.reason ?? 'none'}`,
  ].join(' ')
}

export async function runL4AlphaEvRefresh(env: Bindings, runDate?: string, cadence: 'weekly' | 'monthly' = 'weekly') {
  requireController(env)

  const resp = await controllerFetch(env, '/l4_alpha_ev/refresh', {
    method: 'POST',
    jsonBody: {
      cadence,
      end_date: runDate,
      promote: false,
      dry_run: false,
      trigger_source: 'worker_scheduler',
    },
    timeoutMs: 120_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`l4 alpha EV refresh HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  const status = String(data.status ?? '').toLowerCase()
  const summary = String(data.summary ?? `l4_alpha_ev_refresh status=${status || 'unknown'}`)
  if (!['validated', 'failed_validation'].includes(status)) {
    throw new Error(summary)
  }
  return summary
}

export async function runAllocatorEvFusionRefresh(env: Bindings, runDate?: string, cadence: 'weekly' | 'monthly' = 'weekly') {
  requireController(env)

  const resp = await controllerFetch(env, '/allocator_ev_fusion/refresh', {
    method: 'POST',
    jsonBody: {
      cadence,
      evidence_mode: 'purged_oof',
      end_date: runDate,
      promote: false,
      dry_run: false,
      trigger_source: 'worker_scheduler',
    },
    timeoutMs: 120_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`allocator EV fusion refresh HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  const status = String(data.status ?? '').toLowerCase()
  const summary = String(data.summary ?? `allocator_ev_fusion_refresh status=${status || 'unknown'}`)
  if (!['validated', 'failed_validation'].includes(status)) {
    throw new Error(summary)
  }
  return summary
}

export async function runOpbArmPriorRefresh(
  env: Bindings,
  runDate: string,
  expectedReturnOwner: 'auto' | ExpectedReturnOwner = 'auto',
) {
  requireController(env)

  let resolvedOwner: ExpectedReturnOwner
  if (expectedReturnOwner === 'auto') {
    const servingState = await readCurrentExpectedReturnServingState(env, runDate)
    if (!servingState.expected_return_owner) {
      throw new Error(
        'OPB arm prior refresh requires a contract-compatible expected-return owner; '
        + `l4=${servingState.artifacts.l4_alpha_ev.artifact_state} `
        + `fusion=${servingState.artifacts.allocator_ev_fusion.artifact_state}`,
      )
    }
    resolvedOwner = servingState.expected_return_owner
  } else {
    resolvedOwner = expectedReturnOwner
  }

  const resp = await controllerFetch(env, '/opb_arm_prior/refresh', {
    method: 'POST',
    jsonBody: {
      end_date: runDate,
      expected_return_owner: resolvedOwner,
      lookback_days: 120,
      min_dates: 20,
      limit: 10000,
      roundtrip_cost_bps: 18.0,
      promote: true,
      dry_run: false,
      trigger_source: 'worker_scheduler',
    },
    timeoutMs: 120_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`OPB arm prior refresh HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  const status = String(data.status ?? '').toLowerCase()
  const validation = data.artifact?.validation && typeof data.artifact.validation === 'object'
    ? data.artifact.validation as Record<string, any>
    : {}
  const failedChecks = Array.isArray(validation.failed_checks) ? validation.failed_checks.join(',') : ''
  const summary = [
    `opb_arm_prior_refresh status=${status || 'unknown'}`,
    `owner=${resolvedOwner}`,
    `rows=${Number(data.rows_loaded ?? 0)}`,
    `price_rows=${Number(data.price_rows_loaded ?? 0)}`,
    `promoted=${data.promoted === true ? 1 : 0}`,
    failedChecks ? `failed_checks=${failedChecks}` : '',
  ].filter(Boolean).join(' ')
  if (status !== 'validated' || data.promoted !== true) {
    throw new Error(summary)
  }
  return summary
}

export async function runAllocatorEvFeatureSnapshotBackfill(
  env: Bindings,
  params: {
    startDate: string
    endDate: string
    dryRun?: boolean
    candidateLimit?: number
    l4MinSamples?: number
    l4MinDates?: number
    runId?: string
  },
) {
  requireController(env)
  const nextSessionDate = params.startDate === params.endDate
    ? await nextTwTradingDate(env.KV, params.endDate, env.DB)
    : undefined

  const resp = await controllerFetch(env, '/allocator_ev_fusion/feature_snapshots/backfill', {
    method: 'POST',
    jsonBody: {
      start_date: params.startDate,
      end_date: params.endDate,
      next_session_date: nextSessionDate,
      dry_run: params.dryRun ?? false,
      candidate_limit: params.candidateLimit,
      l4_min_samples: params.l4MinSamples,
      l4_min_dates: params.l4MinDates,
      durable: !(params.dryRun ?? false),
      upstream_run_id: params.runId,
    },
    timeoutMs: 300_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`allocator EV feature snapshot backfill HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  if (data.status === 'spawned' || data.status === 'pending') {
    return String(
      data.summary
      ?? `allocator_ev_feature_snapshot_backfill status=${data.status} range=${params.startDate}..${params.endDate}`,
    )
  }
  const built = Number(data.snapshots_built ?? 0)
  const written = Number(data.written ?? 0)
  if (built <= 0 || (!(params.dryRun ?? false) && written <= 0)) {
    throw new Error(
      `allocator EV feature snapshot incomplete range=${params.startDate}..${params.endDate} built=${built} written=${written}`,
    )
  }
  if (!(params.dryRun ?? false) && params.startDate === params.endDate) {
    const {
      inspectAllocatorSnapshotClosure,
      recordAllocatorEvLifecycle,
    } = await import('./allocatorEvDailyLifecycle')
    const closure = await inspectAllocatorSnapshotClosure(env.DB, params.startDate, {
      allowPointInTimeReconstruction: true,
      learningDb: databaseForDataDomain(env, 'learning'),
      opsDb: databaseForDataDomain(env, 'ops'),
      coreDb: databaseForDataDomain(env, 'core'),
      kv: env.KV,
    })
    if (!closure.ready) {
      throw new Error(
        `allocator EV feature snapshot readback incomplete date=${params.startDate} `
        + `native=${closure.nativeLineageRows} run_native=${closure.runNativeLineageRows} `
        + `reconstructed=${closure.reconstructedLineageRows} rejected=${closure.rejectedLineageRows} `
        + `expected=${closure.expectedRows} published=${closure.publishedRows} actual=${closure.actualRows}`,
      )
    }
    const recorded = await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
      businessDate: params.startDate,
      state: 'snapshot_ready',
      nativeLineageRows: closure.nativeLineageRows,
      snapshotRunId: closure.snapshotRunId,
      snapshotRows: closure.actualRows,
      upstreamRunId: params.runId,
      stageAuthority: params.runId
        ? { stage: 'post_pipeline_chain', canonicalRunId: params.runId }
        : undefined,
    }, databaseForDataDomain(env, 'ops'))
    if (!recorded) {
      throw new Error(`allocator EV feature snapshot stale lifecycle owner run_id=${params.runId ?? 'missing'}`)
    }
  }
  return String(data.summary ?? `allocator_ev_feature_snapshot_backfill status=${data.status ?? 'unknown'}`)
}

export async function runMonthlyStrategyMining(env: Bindings, runDate?: string) {
  requireController(env)

  const dispatchRunDate = runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const runId = `strategy-mining-${dispatchRunDate}-${crypto.randomUUID()}`
  const dispatchKey = strategyMiningDispatchKey(runId)
  const pendingDispatch = {
    run_id: runId,
    run_date: dispatchRunDate,
    status: 'pending',
    created_at: new Date().toISOString(),
  }
  await env.KV.put(dispatchKey, JSON.stringify(pendingDispatch), { expirationTtl: 7 * 24 * 60 * 60 })


  const resp = await controllerFetch(env, '/strategy_mining/monthly_pymoo/run', {
    method: 'POST',
    jsonBody: {
      run_id: runId,
      cadence: 'monthly',
      run_date: dispatchRunDate,
      persist: true,
      dry_run: false,
      trigger_source: 'worker_scheduler',
    },
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`monthly strategy mining HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const data = text ? JSON.parse(text) as Record<string, any> : {}
  if (data.status === 'blocked' || data.status === 'failed' || data.status === 'error') {
    throw new Error(`monthly strategy mining ${data.status}: ${(data.errors ?? data.error ?? data.detail ?? []).toString().slice(0, 300)}`)
  }
  if (data.status === 'triggered') {
    if (String(data.run_id ?? '') !== runId) {
      throw new Error(`monthly strategy mining run_id mismatch: expected=${runId} actual=${data.run_id ?? 'missing'}`)
    }
    const remote = normalizeRemoteExecution(data)
    const current = await env.KV.get(dispatchKey, 'json') as Record<string, unknown> | null
    await env.KV.put(dispatchKey, JSON.stringify({
      ...pendingDispatch,
      ...(current ?? {}),
      status: current?.terminal_status ? 'terminal' : 'accepted',
      backend: remote.backend,
      remote_execution_id: remote.remoteExecutionId,
      function_call_id: remote.functionCallId,
      dispatch_ack: data.dispatch_ack,
      accepted_at: new Date().toISOString(),
    }), { expirationTtl: 7 * 24 * 60 * 60 })
    return [
      'triggered monthly_pymoo_strategy_mining',
      `run_id=${runId}`,
      `backend=${remote.backend}`,
      `remote_execution_id=${remote.remoteExecutionId ?? 'unknown'}`,
      `execution_id=${remote.executionId ?? 'unknown'}`,
      remote.functionCallId ? `function_call_id=${remote.functionCallId}` : null,
      `dispatch_ack=${data.dispatch_ack ?? 'missing'}`,
      'callback expected',
    ].filter(Boolean).join(' ')
  }
  if (data.status === 'already_running') {
    const remote = normalizeRemoteExecution(data)
    return [
      'triggered monthly_pymoo_strategy_mining already_running',
      `backend=${remote.backend}`,
      `remote_execution_id=${remote.remoteExecutionId ?? 'unknown'}`,
      `execution_id=${remote.executionId ?? 'unknown'}`,
      'callback expected',
    ].join(' ')
  }
  throw new Error(
    `monthly strategy mining dispatch not confirmed: status=${data.status ?? 'missing'} `
    + `triggered=${data.triggered === true ? '1' : '0'} `
    + `reason=${data.trigger_reason ?? data.detail ?? 'unexpected_controller_response'}`,
  )
}

function isFailureSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('failed') ||
    normalized.startsWith('error') ||
    normalized.includes(':fail') ||
    normalized.includes(':failed') ||
    normalized.includes(':error') ||
    normalized.includes('gate=fail') ||
    normalized.includes('http')
}

function optunaTriggerSource(reason: string): 'regime_change' | 'risk_anomaly' | 'manual_research' | 'queue' {
  if (reason === 'regime_shift') return 'regime_change'
  if (reason === 'sharpe_rolling' || reason === 'dd_spike') return 'risk_anomaly'
  if (reason === 'manual') return 'manual_research'
  return 'queue'
}

export function summarizeWeeklyValidationChain(results: {
  backtest: string
  monteCarlo: string
  pbo: string
  artifactValidation?: string
}): string {
  const artifact = results.artifactValidation ? ` | artifact(${results.artifactValidation})` : ''
  const summary = `bt(${results.backtest}) | mc(${results.monteCarlo}) | pbo(${results.pbo})${artifact}`
  const failed = Object.entries(results)
    .filter(([, value]) => Boolean(value))
    .filter(([, value]) => isFailureSummary(value))
    .map(([key, value]) => `${key}:${value}`)
  if (failed.length > 0) {
    throw new Error(`weekly validation chain failed: ${failed.join(' | ')}`)
  }
  return summary
}

function truthyFlag(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'modal'
}

export function weeklyBacktestResearchBundleEnabled(env: Bindings): boolean {
  return truthyFlag((env as any).BACKTEST_RESEARCH_BUNDLE_ENABLED) ||
    truthyFlag((env as any).WEEKLY_BACKTEST_RESEARCH_BUNDLE_ENABLED)
}

function buildBacktestResearchBundleRequestBody(runDate: string, runId: string): Record<string, unknown> {
  return {
    run_date: runDate,
    run_id: runId,
    monte_carlo_n: 1000,
    pbo_partitions: 10,
    pbo_source: 'backtest',
    callback_task: 'weekly-backtest',
    trigger_source: 'worker_weekly_backtest',
    dry_run: false,
  }
}

export async function runWeeklyBacktestResearchBundle(env: Bindings, runDate?: string) {
  requireController(env)
  if (runDate && !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    return 'failed: weekly backtest dispatcher requires YYYY-MM-DD run_date'
  }

  const resolvedRunDate = runDate ?? twToday()
  const {
    buildWeeklyBacktestRunId,
    markWeeklyBacktestDispatchFailed,
    markWeeklyBacktestDispatchRunning,
    reserveWeeklyBacktestDispatch,
  } = await import('./weeklyResearchRunFence')
  const opsDb = databaseForDataDomain(env, 'ops')
  const runId = buildWeeklyBacktestRunId(resolvedRunDate)
  const reservation = await reserveWeeklyBacktestDispatch(opsDb, {
    runDate: resolvedRunDate,
    runId,
  })
  if (!reservation.acquired) {
    return `failed: weekly backtest dispatch already active run_id=${reservation.activeRunId ?? 'missing'} owner=${reservation.owner ?? 'missing'}`
  }

  const failDispatch = async (reason: string): Promise<string> => {
    await markWeeklyBacktestDispatchFailed(opsDb, { runDate: resolvedRunDate, runId })
    return `failed: ${reason}`
  }

  let resp: Response
  try {
    resp = await controllerFetch(env, '/backtest/research-bundle/run', {
      method: 'POST',
      jsonBody: buildBacktestResearchBundleRequestBody(resolvedRunDate, runId),
      timeoutMs: 60_000,
    })
  } catch (error) {
    return failDispatch(`weekly backtest controller dispatch error: ${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    return failDispatch(`weekly backtest controller dispatch HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }

  let result: Record<string, any> = {}
  if (text) {
    try {
      result = JSON.parse(text) as Record<string, any>
    } catch {
      return failDispatch(`controller returned non-json for weekly backtest research bundle (${text.slice(0, 300)})`)
    }
  }
  if (result.status === 'failed' || result.status === 'error') {
    return failDispatch(String(result.error ?? result.status))
  }
  if (result.status === 'not_triggered') {
    return failDispatch(String(result.reason ?? 'backtest research bundle not triggered'))
  }

  const returnedRunId = String(result.run_id ?? '')
  const executionId = String(result.execution_id ?? '')
  const functionCallId = String(result.function_call_id ?? '')
  const returnedRunDate = String(result.run_date ?? '').slice(0, 10)
  if (returnedRunId !== runId || returnedRunDate !== resolvedRunDate || !executionId) {
    return failDispatch(
      `weekly backtest dispatcher identity mismatch expected_run_id=${runId} returned_run_id=${returnedRunId || 'missing'} expected_date=${resolvedRunDate} returned_date=${returnedRunDate || 'missing'} execution_id=${executionId || 'missing'}`,
    )
  }

  const running = await markWeeklyBacktestDispatchRunning(opsDb, {
    runDate: resolvedRunDate,
    runId,
    executionId,
  })
  if (!running.transitioned && !String(running.owner ?? '').startsWith('weekly_backtest_terminal:')) {
    return `failed: weekly backtest dispatch fence CAS lost run_id=${runId} owner=${running.owner ?? 'missing'}`
  }

  const remoteRun = functionCallId || executionId
  const fenceState = running.transitioned ? 'running' : String(running.owner)
  return `triggered backtest research bundle run_id=${runId} remote=${remoteRun} fence=${fenceState} callback expected`
}

export async function runWeeklyBacktestEvidenceReconciliation(env: Bindings, runDate?: string) {
  requireController(env)
  if (!runDate) return 'failed: weekly backtest evidence reconciliation requires explicit run_date'

  const resp = await controllerFetch(env, '/backtest/research-bundle/reconcile', {
    method: 'POST',
    jsonBody: {
      run_date: runDate,
      pbo_partitions: 10,
    },
    timeoutMs: 60_000,
  })
  const responseText = await resp.text().catch(() => '')
  if (!resp.ok) return `failed (${resp.status}): ${responseText.slice(0, 200)}`

  let result: Record<string, any> = {}
  try {
    result = responseText ? JSON.parse(responseText) as Record<string, any> : {}
  } catch {
    return `failed: controller returned non-json for weekly backtest evidence reconciliation (${responseText.slice(0, 300)})`
  }
  if (result.status !== 'completed' || result.execution_status !== 'success') {
    return `failed: ${result.error ?? result.status ?? 'weekly backtest evidence reconciliation incomplete'}`
  }
  return String(result.summary ?? `weekly_backtest_reconciled run_date=${runDate} evidence_read_only=true`)
}

export async function runWeeklyValidationChain(env: Bindings, runDate?: string) {
  if (weeklyBacktestResearchBundleEnabled(env)) {
    return runWeeklyBacktestResearchBundle(env, runDate)
  }

  const bt = await runWeeklyBacktest(env, runDate)
  const mc = await runWeeklyMonteCarlo(env, runDate)
  const pbo = await runWeeklyPBO(env, runDate)
  const artifactValidation = await runWeeklyModelArtifactValidation(env)
  return summarizeWeeklyValidationChain({ backtest: bt, monteCarlo: mc, pbo, artifactValidation })
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function finLabBackfillModalTriggerEnabled(env: Bindings): boolean {
  return truthyFlag((env as any).FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED) ||
    truthyFlag((env as any).FINLAB_V4_BACKFILL_MODAL_TRIGGER_ENABLED)
}

function finLabBackfillYears(env: Bindings): number {
  const years = parsePositiveInt((env as any).FINLAB_BACKFILL_YEARS) ?? 3
  if (years !== 3 && years !== 5) {
    throw new Error('FINLAB_BACKFILL_YEARS must be 3 or 5')
  }
  return years
}

function finLabCanonicalWindowDays(env: Bindings): number {
  const windowDays = parsePositiveInt((env as any).FINLAB_BACKFILL_CANONICAL_WINDOW_DAYS) ?? 7
  if (windowDays < 1 || windowDays > 30) {
    throw new Error('FINLAB_BACKFILL_CANONICAL_WINDOW_DAYS must be between 1 and 30')
  }
  return windowDays
}

const FINLAB_DAILY_PRIMARY_LANES_DEFAULT = 'daily_price,chip_diversity,institutional_amount_summary,broker_flow_diversity,regime_context,trading_restrictions,fundamental_factor_diversity'
const FINLAB_DAILY_PRIMARY_CANONICAL_DATASETS_DEFAULT = 'canonical_market_daily,canonical_chip_daily,canonical_institutional_amount_daily,canonical_market_index_daily,canonical_futures_daily,canonical_regime_context_daily,canonical_broker_flow_daily,canonical_broker_rank_daily,canonical_trading_restrictions,canonical_fundamental_features'

function buildFinLabBackfillRunId(years: number, runDate?: string, dailySourceRefresh = false): string {
  const day = (runDate && /^\d{4}-\d{2}-\d{2}$/.test(runDate))
    ? runDate
    : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const mode = dailySourceRefresh ? 'daily' : `${years}y`
  return `finlab-v4-${mode}-${day.replace(/-/g, '')}-${Date.now()}`
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text || undefined
}

function csvItems(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function dailyKeyScopeJsonForLanes(lanes: string | undefined): string | undefined {
  const items = csvItems(lanes)
  if (!items.includes('fundamental_factor_diversity')) return undefined
  return JSON.stringify(items.map((lane) => ({
    lane,
    fields: lane === 'fundamental_factor_diversity' ? ['pe', 'pb'] : [],
  })))
}

type FinLabBackfillRunOptions = {
  continueEveningChain?: boolean
  dailySourceRefresh?: boolean
  callbackMode?: 'evening_chain'
  lanes?: string
  canonicalDatasets?: string
  keyScopeJson?: string
  reuseSuccessfulArtifacts?: boolean
  runId?: string
  dispatchAttempt?: number
  supersedeFunctionCallId?: string
}

function buildFinLabBackfillRequestBody(
  env: Bindings,
  runDate?: string,
  force = false,
  options: FinLabBackfillRunOptions = {},
): Record<string, unknown> {
  const years = finLabBackfillYears(env)
  const dailySourceMode = Boolean(options.dailySourceRefresh || options.continueEveningChain)
  const runId = optionalString(options.runId) ?? buildFinLabBackfillRunId(years, runDate, dailySourceMode)
  const callbackMode = options.callbackMode ?? (options.continueEveningChain ? 'evening_chain' : undefined)
  const dailyTargetDate = runDate && /^\d{4}-\d{2}-\d{2}$/.test(runDate) ? runDate : undefined
  if (dailySourceMode && !dailyTargetDate) {
    throw new Error('FinLab daily source refresh requires YYYY-MM-DD runDate')
  }
  const canonicalStartDate = dailySourceMode
    ? dailyTargetDate
    : optionalString((env as any).FINLAB_BACKFILL_CANONICAL_START_DATE)
  const canonicalEndDate = dailySourceMode
    ? dailyTargetDate
    : optionalString((env as any).FINLAB_BACKFILL_CANONICAL_END_DATE)
  const sourceStartDate = dailySourceMode
    ? dailyTargetDate
    : optionalString((env as any).FINLAB_BACKFILL_SOURCE_START_DATE)
  const sourceEndDate = dailySourceMode
    ? dailyTargetDate
    : optionalString((env as any).FINLAB_BACKFILL_SOURCE_END_DATE)
  const archiveLanes = optionalString((env as any).FINLAB_BACKFILL_LANES)
  if (!dailySourceMode && !archiveLanes) {
    throw new Error('FINLAB_BACKFILL_LANES must be set for archive backfill; empty lanes would run all CORE_SPECS and burn FinLab quota')
  }
  const dailyLanes = dailySourceMode
    ? (optionalString(options.lanes) ?? optionalString((env as any).FINLAB_DAILY_PRICE_LANES) ?? FINLAB_DAILY_PRIMARY_LANES_DEFAULT)
    : undefined
  return {
    years,
    run_id: runId,
    run_date: runDate,
    write_d1: true,
    apply_canonical_d1: true,
    canonical_window_days: dailySourceMode ? 1 : finLabCanonicalWindowDays(env),
    canonical_start_date: canonicalStartDate,
    canonical_end_date: canonicalEndDate,
    source_start_date: sourceStartDate,
    source_end_date: sourceEndDate,
    source_window_days: dailySourceMode ? 1 : undefined,
    canonical_datasets: dailySourceMode
      ? (optionalString(options.canonicalDatasets) ?? optionalString((env as any).FINLAB_DAILY_PRICE_CANONICAL_DATASETS) ?? FINLAB_DAILY_PRIMARY_CANONICAL_DATASETS_DEFAULT)
      : optionalString((env as any).FINLAB_BACKFILL_CANONICAL_DATASETS),
    canonical_limit_per_dataset: parsePositiveInt((env as any).FINLAB_BACKFILL_CANONICAL_LIMIT_PER_DATASET),
    canonical_d1_chunk_size: parsePositiveInt((env as any).FINLAB_BACKFILL_CANONICAL_D1_CHUNK_SIZE),
    gcs_bucket: optionalString((env as any).FINLAB_BACKFILL_GCS_BUCKET),
    gcs_prefix: optionalString((env as any).FINLAB_BACKFILL_GCS_PREFIX) ?? 'finlab/v4/backfill',
    callback_task: 'finlab-v4-backfill',
    trigger_source: 'worker_scheduler',
    trigger_id: runId,
    mode: dailySourceMode ? 'daily_price_primary' : 'archive_backfill',
    force,
    continue_evening_chain: Boolean(options.continueEveningChain),
    daily_source_refresh: dailySourceMode,
    callback_mode: callbackMode,
    lanes: dailySourceMode ? dailyLanes : archiveLanes,
    key_scope_json: dailySourceMode
      ? (optionalString(options.keyScopeJson) ?? optionalString((env as any).FINLAB_DAILY_SOURCE_KEY_SCOPE_JSON) ?? optionalString((env as any).FINLAB_DAILY_PRICE_KEY_SCOPE_JSON) ?? dailyKeyScopeJsonForLanes(dailyLanes))
      : optionalString(options.keyScopeJson),
    reuse_successful_artifacts: Boolean(options.reuseSuccessfulArtifacts),
    dispatch_attempt: Math.max(1, Math.min(5, Math.floor(options.dispatchAttempt ?? 1))),
    supersede_function_call_id: optionalString(options.supersedeFunctionCallId),
    skip_diff_counts: dailySourceMode
      ? !truthyFlag((env as any).FINLAB_DAILY_PRICE_KEEP_DIFF_COUNTS)
      : truthyFlag((env as any).FINLAB_BACKFILL_SKIP_DIFF_COUNTS),
    dry_run: false,
  }
}

export async function runFinLabV4Backfill(
  env: Bindings,
  runDate?: string,
  force = false,
  options: FinLabBackfillRunOptions = {},
) {
  if (!finLabBackfillModalTriggerEnabled(env)) {
    throw new Error('FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED not enabled; FinLab primary canonical refresh is blocked')
  }
  requireController(env)

  const resp = await controllerFetch(env, '/finlab/backfill/run', {
    method: 'POST',
    jsonBody: buildFinLabBackfillRequestBody(env, runDate, force, options),
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    return `failed (${resp.status}): ${text.slice(0, 200)}`
  }

  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  const runId = String(result.run_id ?? 'unknown')
  const functionCallId = String(result.function_call_id ?? result.execution_id ?? 'unknown')
  const dispatchAttempt = Number(result.dispatch_attempt ?? options.dispatchAttempt ?? 1)
  return `triggered finlab-v4-backfill run_id=${runId} function_call_id=${functionCallId} dispatch_attempt=${dispatchAttempt} callback expected`
}

export interface ExternalEvidenceMaterializeResult {
  summary: string
  targetDate: string
  receipt: Record<string, unknown>
  d1Stats: Record<string, unknown>
  controllerDurationMs: number
}

export async function runExternalEvidenceMaterializeDetailed(
  env: Bindings,
  runDate?: string,
): Promise<ExternalEvidenceMaterializeResult> {
  requireController(env)

  const requestStartedAt = new Date().toISOString()
  const resp = await controllerFetch(env, '/external-evidence/materialize', {
    method: 'POST',
    jsonBody: {
      target_date: runDate,
      as_of_date: runDate,
      trigger_source: 'worker_scheduler',
      dry_run: false,
    },
    timeoutMs: 180_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    const targetDate = runDate ?? twToday()
    if (resp.status === 524) {
      const receipt = await awaitExternalEvidenceMaterializationReceipt(env, targetDate, requestStartedAt)
      if (receipt) {
        return {
          summary: `external evidence receipt=ready_via_d1_readback target=${targetDate} controller_http=524`,
          targetDate,
          receipt,
          d1Stats: { readback_fallback: 1, controller_http_status: 524 },
          controllerDurationMs: 0,
        }
      }
    }
    throw new Error(
      'external evidence materialize HTTP'
      + resp.status
      + (text ? '(' + text.slice(0, 300) + ')' : ''),
    )
  }
  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status === 'failed' || result.status === 'error') {
    throw new Error('external evidence materialize failed: ' + String(result.error ?? result.status))
  }

  const targetDate = String(result.target_date ?? runDate ?? 'latest')
  const gdeltStatus = String(result.gdelt_status ?? 'unknown')
  const gdeltItems = Number(result.gdelt_items_built ?? 0)
  const features = Number(result.stock_theme_features_upserted ?? 0)
  const receipt = result.materialization_receipt && typeof result.materialization_receipt === 'object'
    ? result.materialization_receipt as Record<string, unknown>
    : {}
  const d1Stats = result.d1_stats && typeof result.d1_stats === 'object'
    ? result.d1_stats as Record<string, unknown>
    : {}
  if (receipt.status !== 'ready') {
    throw new Error(
      'external evidence materialization receipt incomplete: '
      + JSON.stringify(receipt).slice(0, 500),
    )
  }

  const summary = [
    'external evidence',
    'receipt=' + String(receipt.status),
    'target=' + targetDate,
    'gdelt=' + gdeltStatus,
    'items=' + gdeltItems,
    'stock_theme_features=' + features,
    'd1_queries=' + Number(d1Stats.logical_queries ?? 0),
    'd1_http_attempts=' + Number(d1Stats.http_attempts ?? 0),
    'd1_retries=' + Number(d1Stats.retries ?? 0),
    'write_batches=' + Number(d1Stats.write_batches ?? 0),
  ].join(' ')

  return {
    summary,
    targetDate,
    receipt,
    d1Stats,
    controllerDurationMs: Number(result.duration_ms ?? 0),
  }
}

export async function runExternalEvidenceMaterialize(env: Bindings, runDate?: string): Promise<string> {
  return (await runExternalEvidenceMaterializeDetailed(env, runDate)).summary
}


export async function runOptunaQueueProcessor(env: Bindings) {
  requireController(env)

  const {
    acquireOptunaQueueProcessorD1Lock,
    acquireOptunaQueueProcessorLock,
    acquireOptunaRunD1Lock,
    closeOptunaRunD1Lock,
    markFailed,
    markProcessed,
    markRetryable,
    markTriggered,
    popNextPending,
    releaseOptunaQueueProcessorD1Lock,
    releaseOptunaQueueProcessorLock,
    requeueStaleInProgress,
  } = await import('./optunaQueue')
  const lockRunId = `optuna-queue:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const opsDb = databaseForDataDomain(env, 'ops')
  const d1Lock = await acquireOptunaQueueProcessorD1Lock(opsDb, lockRunId, 3600)
  if (!d1Lock.acquired) return 'locked: optuna queue processor already running (d1)'
  const locked = await acquireOptunaQueueProcessorLock(env.KV, lockRunId, 3600)
  if (!locked) {
    await releaseOptunaQueueProcessorD1Lock(opsDb, lockRunId)
    return 'locked: optuna queue processor already running'
  }

  let entry: Awaited<ReturnType<typeof popNextPending>> = null
  let runLock: Awaited<ReturnType<typeof acquireOptunaRunD1Lock>> | null = null
  try {
    await requeueStaleInProgress(env.KV, 6 * 3600, 3)
    entry = await popNextPending(env.KV)
    if (!entry) return 'empty'

    const isPerRegime = entry.target === 'per_regime'
    const runLockRunId = `optuna-per-regime:${entry.id}:${Date.now()}`
    runLock = isPerRegime
      ? await acquireOptunaRunD1Lock(opsDb, entry, runLockRunId, 6 * 3600)
      : null
    if (runLock && !runLock.acquired) {
      const retryStatus = await markRetryable(env.KV, entry.id, `d1_run_lock_busy:${runLock.lock_key}`)
      return `${retryStatus}: ${entry.id} d1_run=${runLock.lock_key}`
    }

    const endpoint = isPerRegime ? '/optuna/per_regime/run' : `/optuna/${entry.target}`
    const body = isPerRegime
      ? {
        target: 'sltp',
        n_trials: 50,
        subset_size: 200,
        window_days: 365,
        push_kv: true,
        dry_run: false,
        cadence: 'queue',
        research_data_source: 'snapshot',
        trigger_source: optunaTriggerSource(entry.reason),
        trigger_id: entry.id,
      }
      : { n_trials: 200, push_kv: true, dry_run: false }

    const resp = await controllerFetch(env, endpoint, {
      method: 'POST',
      jsonBody: body,
      timeoutMs: isPerRegime ? 60_000 : 3_500_000,
    })
    if (!resp.ok) {
      const responseText = await resp.text().catch(() => '')
      if (runLock?.acquired) await closeOptunaRunD1Lock(opsDb, entry.id, `dispatch_http_${resp.status}`)
      const message = `HTTP ${resp.status}: ${responseText.slice(0, 300)}`
      if ([409, 429, 502, 503, 504].includes(resp.status)) {
        const retryStatus = await markRetryable(env.KV, entry.id, message)
        return `${retryStatus}: ${entry.id} HTTP${resp.status}`
      }
      await markFailed(env.KV, entry.id, message)
      return `failed: ${entry.id} HTTP${resp.status}`
    }

    const data = await resp.json() as Record<string, any>
    const sandboxId = data.push_response?.sandbox_id
      ?? data.push_response?.id
      ?? (data.kv_push_ok ? data.sandbox_id : undefined)
    const executionId = data.execution_id ? String(data.execution_id) : undefined
    const functionCallId = data.function_call_id ? String(data.function_call_id) : undefined
    const asyncRunId = executionId ?? functionCallId ?? (data.run_id ? String(data.run_id) : undefined)
    const executor = data.executor
      ? String(data.executor)
      : (functionCallId ? 'modal' : 'cloud_run_job')

    if (isPerRegime) {
      if (!asyncRunId) {
        if (runLock?.acquired) await closeOptunaRunD1Lock(opsDb, entry.id, 'dispatch_missing_run_id')
        const retryStatus = await markRetryable(env.KV, entry.id, 'per_regime_dispatch_missing_async_run_id')
        return `${retryStatus}: ${entry.id} missing_async_run_id`
      }
      await markTriggered(env.KV, entry.id, {
        run_id: asyncRunId,
        note: `triggered_${executor}=${asyncRunId} trigger_source=${data.trigger_source ?? optunaTriggerSource(entry.reason)} d1_run_lock=${runLock?.lock_key ?? 'none'} callback_expected`,
      })
      return `success: dispatched ${entry.id} ${executor}=${asyncRunId} child_receipt_owner=optuna-per-regime`
    }

    await markProcessed(env.KV, entry.id, {
      sandbox_id: sandboxId,
      note: `robust_sharpe=${data.robust_sharpe ?? 'n/a'}`,
    })
    return `processed: ${entry.id}${sandboxId ? ` sandbox=${sandboxId.slice(-12)}` : ''}`
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (entry) {
      if (runLock?.acquired) await closeOptunaRunD1Lock(opsDb, entry.id, 'dispatch_exception')
      const retryStatus = await markRetryable(env.KV, entry.id, msg)
      return `${retryStatus}: ${entry.id} ${msg.slice(0, 100)}`
    }
    return `failed: optuna queue claim ${msg.slice(0, 100)}`
  } finally {
    await releaseOptunaQueueProcessorLock(env.KV, lockRunId)
    await releaseOptunaQueueProcessorD1Lock(opsDb, lockRunId)
  }
}
export async function runWeeklyModelRegistryCheck(env: Bindings) {
  requireController(env)
  const result = await controllerJson<Record<string, any>>(
    env,
    '/model_pool/artifact_registry/promotion_queue',
    { timeoutMs: 60_000 },
  )
  const rows = Array.isArray(result.queue) ? result.queue : []
  const autoReady = rows.filter((row: any) => row.promotion_decision === 'auto_promote_candidate').length
  const blocked = rows.filter((row: any) => String(row.promotion_decision ?? '').includes('blocked')).length
  const lifecycle = await controllerJson<Record<string, any>>(
    env,
    '/config_pool/weekly_eval',
    {
      method: 'POST',
      jsonBody: { apply: false, confirm: false },
      timeoutMs: 300_000,
    },
  )
  const lifecycleStatus = String(lifecycle.status ?? 'missing')
  if (!['dry_run', 'no_challenger'].includes(lifecycleStatus)) {
    throw new Error(`weekly_lifecycle_dry_run_invalid_status:${lifecycleStatus}`)
  }
  return `model_registry readback=ok queue=${rows.length} auto=${autoReady} blocked=${blocked} lifecycle dry-run=${lifecycleStatus}`
}

export async function runWeeklyBacktest(env: Bindings, runDate = twToday()) {
  requireController(env)

  if (runDate !== twToday()) {
    return `failed: historical canonical rerun forbidden (requested=${runDate}; use /backtest/historical-weekly-replay comparison-only)`
  }

  const resp = await controllerFetch(env, `/backtest/run?run_date=${encodeURIComponent(runDate)}`, {
    method: 'POST',
    timeoutMs: 300_000,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return `failed (${resp.status}): ${text.slice(0, 200)}`
  }

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  return `trades=${result.total_trades ?? 0}, win=${result.win_rate ?? '-'}, sharpe=${result.sharpe ?? '-'}`
}

export async function runWeeklyMonteCarlo(env: Bindings, runDate = twToday()) {
  requireController(env)

  if (runDate !== twToday()) {
    return `failed: historical canonical MC rerun forbidden (requested=${runDate}; use historical comparison-only replay)`
  }

  const results: string[] = []
  for (const source of ['paper', 'backtest'] as const) {
    const evidenceDate = `&expected_run_date=${encodeURIComponent(runDate)}`
    const resp = await controllerFetch(env, `/backtest/monte-carlo?n=1000&source=${source}${evidenceDate}&persist=true&evidence_scope=canonical_current`, {
      method: 'POST',
      timeoutMs: 120_000,
    }).catch(() => null)
    if (!resp?.ok) {
      results.push(`${source}:failed`)
      continue
    }

    const result = await resp.json() as Record<string, any>
    if (result.status === 'failed' || result.status === 'error') {
      results.push(`${source}:${result.error ?? 'failed'}`)
    } else {
      const mddRaw = String(result.mdd_95th ?? '').trim()
      const mdd95 = mddRaw.endsWith('%')
        ? Number.parseFloat(mddRaw.slice(0, -1)) / 100
        : Number(mddRaw)
      const threshold = Number(result.fail_threshold ?? result.max_mdd_95th ?? 0.30)
      const verdict = String(result.go_live_verdict ?? 'UNKNOWN')
      const gate = Number.isFinite(mdd95) && Number.isFinite(threshold) && mdd95 <= threshold ? 'pass' : 'fail'
      const nextAction = gate === 'pass'
        ? 'promotion_gate_clear'
        : 'run_capacity_stop_allocator_remediation_simulation'
      results.push(
        `${source}:${verdict}` +
        `(gate=${gate};mdd95=${Number.isFinite(mdd95) ? mdd95 : 'n/a'};` +
        `threshold=${Number.isFinite(threshold) ? threshold : 'n/a'};` +
        `method=${result.method ?? 'block_bootstrap'};next=${nextAction})`,
      )
    }
  }

  return results.join(', ')
}

export async function runWeeklyPBO(env: Bindings, runDate = twToday()) {
  requireController(env)

  if (runDate !== twToday()) {
    return `failed: historical canonical PBO rerun forbidden (requested=${runDate}; use historical comparison-only replay)`
  }

  const resp = await controllerFetch(env, `/backtest/pbo?partitions=10&source=backtest&expected_run_date=${encodeURIComponent(runDate)}&persist=true&evidence_scope=canonical_current`, {
    method: 'POST',
    timeoutMs: 120_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  if (result.status === 'insufficient_evidence') {
    return `blocked:insufficient_evidence(observed=${result.observed_trades ?? 'n/a'};required=${result.required_trades ?? 'n/a'};promotion_eligible=false)`
  }
  return `PBO=${result.pbo}(${result.go_live_verdict}), OOS=${result.oos_mean_return}`
}

export async function runWeeklyModelArtifactCandidateValidation(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/model_pool/artifact_registry/candidate_validation_chain', {
    method: 'POST',
    jsonBody: {
      limit: 200,
      lookback_days: 90,
      mc_simulations: 1000,
      persist: true,
      refresh_validation: false,
    },
    timeoutMs: 180_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  const errorCount = Array.isArray(result.errors) ? result.errors.length : 0
  if (result.status === 'partial' || errorCount > 0) return `failed: partial errors=${errorCount}`
  return `artifacts=${result.count ?? 0}, generated=${result.generated ?? 0}, updated=${result.updated ?? 0}, errors=${errorCount}`
}

export async function runWeeklyModelArtifactValidation(env: Bindings) {
  requireController(env)

  const candidateEvidence = await runWeeklyModelArtifactCandidateValidation(env)
  if (isFailureSummary(candidateEvidence)) return `failed: candidate_evidence ${candidateEvidence}`

  const resp = await controllerFetch(env, '/model_pool/artifact_registry/validation_chain', {
    method: 'POST',
    jsonBody: { limit: 200, persist: true },
    timeoutMs: 120_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  await invalidateModelPoolReadCache(env.KV)
  return `candidate(${candidateEvidence}) | gate(artifacts=${result.count ?? 0}, updated=${result.updated ?? 0}, ready=${result.ready ?? 0}, blocked=${result.blocked ?? 0})`
}

export async function runWeeklyAlphaQuality(env: Bindings) {
  requireController(env)

  const { getTradingConfig } = await import('./tradingConfig')
  const cfg = await getTradingConfig(env.KV)
  const quality = cfg.alphaFramework.quality
  const params = new URLSearchParams({
    limit: String(quality.outcomeLimit),
    min_samples: String(quality.minSamples),
    min_bucket_samples: String(quality.minBucketSamples),
  })

  const resp = await controllerFetch(env, `/config_pool/alpha_quality?${params.toString()}`, {
    method: 'GET',
    timeoutMs: 60_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'skipped') return `skipped:${result.reason ?? 'insufficient_data'} (${result.sample_count ?? 0}/${result.required_samples ?? '-'})`
  if (result.status !== 'completed') return `failed:${result.reason ?? result.status ?? 'unknown'}`

  const alerts = Array.isArray(result.alerts) ? result.alerts.length : 0
  const samples = result.sample_count ?? 0
  const bucketStats = (result.bucket_stats ?? {}) as Record<string, any>
  const weakBuckets = Object.entries(bucketStats)
    .filter(([, stat]) => Number(stat?.count ?? 0) >= 8 && Number(stat?.avg_pnl_r ?? 0) < 0)
    .map(([bucket, stat]) => `${bucket}:${stat.avg_pnl_r}`)
    .slice(0, 4)
    .join(',')

  return `samples=${samples}, alerts=${alerts}${weakBuckets ? `, weak=[${weakBuckets}]` : ''}`
}

const ACTIVE_WEEKLY_DRIFT_MODEL_NAMES = new Set([
  'LightGBM', 'XGBoost', 'ExtraTrees', 'TabM',
  'GNN', 'DLinear', 'PatchTST', 'iTransformer',
])

const MODEL_GROUP_BY_NAME: Readonly<Record<string, 'tree' | 'dlinear' | 'patchtst'>> = {
  LightGBM: 'tree',
  XGBoost: 'tree',
  ExtraTrees: 'tree',
  DLinear: 'dlinear',
  PatchTST: 'patchtst',
}

const FORMAL_ARTIFACT_LIFECYCLE_BY_NAME: Readonly<Record<string, string>> = {
  GNN: 'graph_artifact_retrain_registration',
  TabM: 'tabular_artifact_retrain_registration',
  iTransformer: 'sequence_artifact_retrain_registration',
}

const DRIFT_FAMILY_BY_NAME: Readonly<Record<string, string>> = {
  LightGBM: 'tree',
  XGBoost: 'tree',
  ExtraTrees: 'tree',
  TabM: 'tabular_neural',
  GNN: 'graph',
  DLinear: 'sequence',
  PatchTST: 'learned_sequence',
  iTransformer: 'learned_sequence',
}

function modelNamesFromDriftEvidence(evidence: Record<string, any>): string[] {
  const explicit = Array.isArray(evidence.drift_target_models)
    ? evidence.drift_target_models
    : []
  const perModel = evidence.per_model && typeof evidence.per_model === 'object'
    ? Object.entries(evidence.per_model)
      .filter(([, value]: [string, any]) => value?.needs_retrain === true || value?.drifted === true)
      .map(([name]) => name)
    : []
  return [...new Set([...explicit, ...perModel].map(String))]
    .filter((name) => ACTIVE_WEEKLY_DRIFT_MODEL_NAMES.has(name))
}

export async function runWeeklyDriftDetection(env: Bindings, runDate = twToday()) {
  requireController(env)
  if (runDate !== twToday()) {
    return {
      status: 'unavailable' as const,
      as_of_date: runDate,
      needs_retrain: false,
      drift_target_models: [] as string[],
      drift_target_families: [] as string[],
      reason: 'historical_feature_drift_reconstruction_forbidden',
      evidence: null,
    }
  }
  const { runWeeklyDriftCheck } = await import('./localMaintenance')
  const evidence = await runWeeklyDriftCheck(env)
  if (!evidence) {
    return {
      status: 'unavailable' as const,
      as_of_date: runDate,
      needs_retrain: false,
      drift_target_models: [] as string[],
      drift_target_families: [] as string[],
      reason: 'feature_drift_evidence_missing',
      evidence: null,
    }
  }
  const driftTargetModels = modelNamesFromDriftEvidence(evidence)
  const driftTargetFamilies = [...new Set(driftTargetModels.map((name) => DRIFT_FAMILY_BY_NAME[name]).filter(Boolean))]
  return {
    status: 'ready' as const,
    as_of_date: runDate,
    needs_retrain: evidence.needs_retrain === true,
    drift_target_models: driftTargetModels,
    drift_target_families: driftTargetFamilies,
    reason: evidence.needs_retrain === true && driftTargetModels.length === 0
      ? 'model_level_drift_targets_missing'
      : null,
    evidence,
  }
}

export async function runWeeklyDriftRetrain(
  env: Bindings,
  options: { runDate?: string; driftTargetModels: string[] },
) {
  requireController(env)
  const driftTargetModels = [...new Set(options.driftTargetModels)]
    .filter((name) => ACTIVE_WEEKLY_DRIFT_MODEL_NAMES.has(name))
  const trainModelGroups = [...new Set(driftTargetModels.map((name) => MODEL_GROUP_BY_NAME[name]).filter(Boolean))]
  const artifactLifecycleTargets = driftTargetModels.filter((name) => Boolean(FORMAL_ARTIFACT_LIFECYCLE_BY_NAME[name]))
  if (trainModelGroups.length === 0 && artifactLifecycleTargets.length === 0) {
    return 'weekly_drift skipped: no supported retrain groups'
  }
  const driftTargetFamilies = [...new Set(driftTargetModels.map((name) => DRIFT_FAMILY_BY_NAME[name]).filter(Boolean))]
  const artifactLifecycleContracts = Object.fromEntries(
    artifactLifecycleTargets.map((name) => [name, FORMAL_ARTIFACT_LIFECYCLE_BY_NAME[name]]),
  )
  const result = await controllerPostJson<any>(env, '/retrain/universal', {
    limit: 2500,
    run_date: options.runDate ?? twToday(),
    candidate_type: 'weekly_drift',
    force_monthly: false,
    drift_target_models: driftTargetModels,
    drift_target_families: driftTargetFamilies,
    train_model_groups: trainModelGroups,
    artifact_lifecycle_targets: artifactLifecycleTargets,
    artifact_lifecycle_contracts: artifactLifecycleContracts,
    artifact_lifecycle_only: trainModelGroups.length === 0,
    // Candidate registration is owned by the formal artifact-registry follow-up.
    register_challengers: false,
    promotion_eligible_models: [],
  })
  return `weekly_drift candidate dispatched status=${result?.status ?? 'unknown'} run_id=${result?.run_id ?? '-'} models=${driftTargetModels.join(',')}`
}

export async function runWeeklyRetrain(env: Bindings) {
  requireController(env)

  const result = await controllerPostJson<any>(env, '/retrain/universal', { limit: 2500 })
  const trainResult = result?.train_result ?? {}
  console.log(
    `[WeeklyRetrain] Universal done: ` +
    `${result.stocks_sent ?? 0} stocks, ${result.total_prep_rows ?? 0} rows, ` +
    `${result.batch_count ?? 0} batches. ` +
    `Models: ${JSON.stringify(Object.fromEntries(
      Object.entries(trainResult.results ?? {}).map(([key, value]: [string, any]) => [key, value.accuracy ?? value.error ?? 'unknown']),
    ))}`,
  )
}

type ExternalEvidenceReadbackRow = {
  generated_at: string | null
  source_quality_rows: number | null
  theme_rows: number | null
  feature_rows: number | null
}

export async function readExternalEvidenceMaterializationReceipt(
  env: Bindings,
  targetDate: string,
  notBefore?: string,
): Promise<Record<string, unknown> | null> {
  const marketDb = databaseForDataDomain(env, 'market')
  const row = await marketDb.prepare(`
    WITH latest_quality AS (
      SELECT json_extract(metrics_json, '$.generated_at') AS generated_at,
             COUNT(*) AS source_quality_rows
        FROM source_quality_metrics
       WHERE as_of_date = ?
         AND source IN ('official_rss', 'company_ir_rss', 'gdelt_events')
       GROUP BY json_extract(metrics_json, '$.generated_at')
      HAVING COUNT(*) = 3
       ORDER BY generated_at DESC
       LIMIT 1
    )
    SELECT latest_quality.generated_at,
           latest_quality.source_quality_rows,
           (SELECT COUNT(*) FROM theme_signals
             WHERE date = ? AND generated_at = latest_quality.generated_at) AS theme_rows,
           (SELECT COUNT(*) FROM stock_theme_features
             WHERE date = ? AND generated_at = latest_quality.generated_at) AS feature_rows
      FROM latest_quality
  `).bind(targetDate, targetDate, targetDate).first<ExternalEvidenceReadbackRow>()

  const sourceQualityRows = Number(row?.source_quality_rows ?? 0)
  const themeRows = Number(row?.theme_rows ?? 0)
  const featureRows = Number(row?.feature_rows ?? 0)
  const generatedAt = String(row?.generated_at ?? '').trim()
  if (!generatedAt || sourceQualityRows !== 3 || themeRows < 1 || featureRows < 1) return null
  const generatedAtMs = Date.parse(generatedAt)
  const notBeforeMs = Date.parse(String(notBefore ?? ''))
  if (Number.isFinite(notBeforeMs) && (!Number.isFinite(generatedAtMs) || generatedAtMs < notBeforeMs)) return null

  return {
    schema_version: 'external-evidence-d1-readback-receipt-v1',
    status: 'ready',
    target_date: targetDate,
    as_of_date: targetDate,
    generated_at: generatedAt,
    source_quality_rows: sourceQualityRows,
    actual_theme_rows: themeRows,
    actual_feature_rows: featureRows,
    recovery_reason: 'controller_http_524_after_origin_commit',
  }
}

async function awaitExternalEvidenceMaterializationReceipt(
  env: Bindings,
  targetDate: string,
  notBefore: string,
): Promise<Record<string, unknown> | null> {
  for (const delayMs of [2_000, 5_000, 10_000, 15_000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    const receipt = await readExternalEvidenceMaterializationReceipt(env, targetDate, notBefore).catch(() => null)
    if (receipt) return receipt
  }
  return null
}
