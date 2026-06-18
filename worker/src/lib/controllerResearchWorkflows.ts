import type { Bindings } from '../types'
import { controllerFetch, controllerJson, controllerPostJson } from './controllerClient'
import { invalidateModelPoolReadCache } from './modelPoolReadCache'

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
  ga?: {
    populationSize: number
    generations: number
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
  const executionId = String(data.execution_id ?? '')
  const runId = String(data.run_id ?? '')
  const summary = `optuna research Job triggered cadence=${options.cadence} run_id=${runId || 'unknown'} execution_id=${executionId || 'unknown'} callback expected`

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
  await ensureParameterCandidateTables(env.DB)

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

export async function runWeeklyOptunaResearch(env: Bindings, runDate?: string) {
  return runOptunaResearch(env, {
    cadence: 'weekly',
    nTrials: 80,
    subsetSize: 400,
    runDate,
    ga: {
      populationSize: 12,
      generations: 4,
    },
  })
}

export async function runMonthlyOptunaResearch(env: Bindings, runDate?: string) {
  return runOptunaResearch(env, {
    cadence: 'monthly',
    nTrials: 300,
    subsetSize: 1500,
    runDate,
    ga: {
      populationSize: 36,
      generations: 12,
    },
  })
}

export async function runMonthlyStrategyMining(env: Bindings, runDate?: string) {
  requireController(env)

  const resp = await controllerFetch(env, '/strategy_mining/monthly_pymoo/run', {
    method: 'POST',
    jsonBody: {
      cadence: 'monthly',
      run_date: runDate,
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
    return `triggered monthly_pymoo_strategy_mining execution_id=${data.execution_id ?? 'unknown'} callback expected`
  }
  if (data.status === 'already_running') {
    return `triggered monthly_pymoo_strategy_mining already_running execution_id=${data.execution_id ?? 'unknown'} callback expected`
  }
  const pool = data.feature_pool && typeof data.feature_pool === 'object' ? data.feature_pool as Record<string, any> : {}
  return [
    'monthly_pymoo_strategy_mining preflight_ready',
    `features=${pool.eligible_for_alpha_mining ?? 'unknown'}`,
    `triggered=${data.triggered === true ? '1' : '0'}`,
    'production_effect=none',
  ].join(' ')
}

function isFailureSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('failed') ||
    normalized.startsWith('error') ||
    normalized.includes(':failed') ||
    normalized.includes(':error') ||
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

function buildBacktestResearchBundleRequestBody(runDate?: string): Record<string, unknown> {
  return {
    run_date: runDate,
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

  const resp = await controllerFetch(env, '/backtest/research-bundle/run', {
    method: 'POST',
    jsonBody: buildBacktestResearchBundleRequestBody(runDate),
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    return `failed (${resp.status}): ${text.slice(0, 200)}`
  }

  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  if (result.status === 'not_triggered') return `failed: ${result.reason ?? 'backtest research bundle not triggered'}`

  const runId = String(result.run_id ?? '')
  const functionCallId = String(result.function_call_id ?? '')
  const executionId = String(result.execution_id ?? '')
  const remoteRun = functionCallId || executionId || runId || 'unknown'
  return `triggered backtest research bundle run_id=${runId || 'unknown'} remote=${remoteRun} callback expected`
}

export async function runWeeklyValidationChain(env: Bindings, runDate?: string) {
  if (weeklyBacktestResearchBundleEnabled(env)) {
    return runWeeklyBacktestResearchBundle(env, runDate)
  }

  const bt = await runWeeklyBacktest(env)
  const mc = await runWeeklyMonteCarlo(env)
  const pbo = await runWeeklyPBO(env)
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

export function universalRetrainModalTriggerEnabled(env: Bindings): boolean {
  return truthyFlag((env as any).UNIVERSAL_RETRAIN_MODAL_TRIGGER_ENABLED) ||
    truthyFlag((env as any).RETRAIN_UNIVERSAL_MODAL_TRIGGER_ENABLED) ||
    String((env as any).UNIVERSAL_RETRAIN_EXECUTOR ?? '').trim().toLowerCase() === 'modal' ||
    String((env as any).RETRAIN_UNIVERSAL_EXECUTOR ?? '').trim().toLowerCase() === 'modal'
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

const FINLAB_DAILY_PRIMARY_LANES_DEFAULT = 'daily_price,emerging_price_diversity,chip_diversity,institutional_amount_summary,emerging_chip_diversity'
const FINLAB_DAILY_PRIMARY_CANONICAL_DATASETS_DEFAULT = 'canonical_market_daily,canonical_chip_daily,canonical_institutional_amount_daily,canonical_broker_flow_daily'

function buildFinLabBackfillRunId(years: number, runDate?: string): string {
  const day = (runDate && /^\d{4}-\d{2}-\d{2}$/.test(runDate))
    ? runDate
    : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  return `finlab-v4-${years}y-${day.replace(/-/g, '')}-${Date.now()}`
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text || undefined
}

function buildFinLabBackfillRequestBody(
  env: Bindings,
  runDate?: string,
  force = false,
  options: { continueEveningChain?: boolean } = {},
): Record<string, unknown> {
  const years = finLabBackfillYears(env)
  const runId = buildFinLabBackfillRunId(years, runDate)
  const dailyPriceMode = Boolean(options.continueEveningChain)
  return {
    years,
    run_id: runId,
    run_date: runDate,
    write_d1: true,
    apply_canonical_d1: true,
    canonical_window_days: finLabCanonicalWindowDays(env),
    canonical_start_date: optionalString((env as any).FINLAB_BACKFILL_CANONICAL_START_DATE),
    canonical_end_date: optionalString((env as any).FINLAB_BACKFILL_CANONICAL_END_DATE),
    canonical_datasets: dailyPriceMode
      ? (optionalString((env as any).FINLAB_DAILY_PRICE_CANONICAL_DATASETS) ?? FINLAB_DAILY_PRIMARY_CANONICAL_DATASETS_DEFAULT)
      : optionalString((env as any).FINLAB_BACKFILL_CANONICAL_DATASETS),
    canonical_limit_per_dataset: parsePositiveInt((env as any).FINLAB_BACKFILL_CANONICAL_LIMIT_PER_DATASET),
    canonical_d1_chunk_size: parsePositiveInt((env as any).FINLAB_BACKFILL_CANONICAL_D1_CHUNK_SIZE),
    gcs_bucket: optionalString((env as any).FINLAB_BACKFILL_GCS_BUCKET),
    gcs_prefix: optionalString((env as any).FINLAB_BACKFILL_GCS_PREFIX) ?? 'finlab/v4/backfill',
    callback_task: 'finlab-v4-backfill',
    trigger_source: 'worker_scheduler',
    trigger_id: runId,
    mode: dailyPriceMode ? 'daily_price_primary' : 'archive_backfill',
    force,
    continue_evening_chain: Boolean(options.continueEveningChain),
    lanes: dailyPriceMode
      ? (optionalString((env as any).FINLAB_DAILY_PRICE_LANES) ?? FINLAB_DAILY_PRIMARY_LANES_DEFAULT)
      : optionalString((env as any).FINLAB_BACKFILL_LANES),
    skip_diff_counts: dailyPriceMode
      ? !truthyFlag((env as any).FINLAB_DAILY_PRICE_KEEP_DIFF_COUNTS)
      : truthyFlag((env as any).FINLAB_BACKFILL_SKIP_DIFF_COUNTS),
    dry_run: false,
  }
}

export async function runFinLabV4Backfill(
  env: Bindings,
  runDate?: string,
  force = false,
  options: { continueEveningChain?: boolean } = {},
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
  return `triggered finlab-v4-backfill run_id=${runId} function_call_id=${functionCallId} callback expected`
}

export async function runOptunaQueueProcessor(env: Bindings) {
  requireController(env)

  const {
    acquireOptunaQueueProcessorD1Lock,
    acquireOptunaQueueProcessorLock,
    acquireOptunaRunD1Lock,
    popNextPending,
    markProcessed,
    markFailed,
    releaseOptunaQueueProcessorD1Lock,
    releaseOptunaQueueProcessorLock,
  } = await import('./optunaQueue')
  const lockRunId = `optuna-queue:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const d1Lock = await acquireOptunaQueueProcessorD1Lock(env.DB, lockRunId, 3600)
  if (!d1Lock.acquired) return 'locked: optuna queue processor already running (d1)'
  const locked = await acquireOptunaQueueProcessorLock(env.KV, lockRunId, 3600)
  if (!locked) {
    await releaseOptunaQueueProcessorD1Lock(env.DB, lockRunId)
    return 'locked: optuna queue processor already running'
  }

  let entry: Awaited<ReturnType<typeof popNextPending>> = null
  try {
    entry = await popNextPending(env.KV)
    if (!entry) return 'empty'

    const isPerRegime = entry.target === 'per_regime'
    const runLockRunId = `optuna-per-regime:${entry.id}:${Date.now()}`
    const runLock = isPerRegime
      ? await acquireOptunaRunD1Lock(env.DB, entry, runLockRunId, 6 * 3600)
      : null
    if (runLock && !runLock.acquired) {
      await markProcessed(env.KV, entry.id, {
        note: `skipped_d1_run_lock=${runLock.lock_key}`,
      })
      return `locked: ${entry.id} d1_run=${runLock.lock_key}`
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
      const text = await resp.text().catch(() => '')
      await markFailed(env.KV, entry.id, `HTTP ${resp.status}: ${text.slice(0, 300)}`)
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

    await markProcessed(env.KV, entry.id, {
      sandbox_id: sandboxId,
      note: asyncRunId
        ? `triggered_${executor}=${asyncRunId} trigger_source=${data.trigger_source ?? optunaTriggerSource(entry.reason)}${runLock ? ` d1_run_lock=${runLock.lock_key}` : ''}`
        : `robust_sharpe=${data.robust_sharpe ?? 'n/a'}`,
    })
    return asyncRunId
      ? `triggered: ${entry.id} ${executor}=${asyncRunId}`
      : `processed: ${entry.id}${sandboxId ? ` sandbox=${sandboxId.slice(-12)}` : ''}`
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (entry) {
      await markFailed(env.KV, entry.id, msg)
      return `failed: ${entry.id} ${msg.slice(0, 100)}`
    }
    return `failed: optuna queue claim ${msg.slice(0, 100)}`
  } finally {
    await releaseOptunaQueueProcessorLock(env.KV, lockRunId)
    await releaseOptunaQueueProcessorD1Lock(env.DB, lockRunId)
  }
}

export async function runWeeklyLifecycleCheck(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/model_pool/promote_check', {
    method: 'POST',
    jsonBody: { apply: false, confirm: false },
    timeoutMs: 60_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`

  const transitions = (result.actions ?? [])
    .filter((action: any) => !String(action.transition ?? '').endsWith('_blocked'))
    .map((action: any) => `${action.model}:${action.transition}`)
    .join(',') || 'none'
  return `model_pool dry_run=${result.actions_count ?? 0} [${transitions}]`
}

export async function runWeeklyBacktest(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/backtest/run', {
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

export async function runWeeklyMonteCarlo(env: Bindings) {
  requireController(env)

  const results: string[] = []
  for (const source of ['paper', 'backtest'] as const) {
    const resp = await controllerFetch(env, `/backtest/monte-carlo?n=1000&source=${source}`, {
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
      results.push(`${source}:${result.go_live_verdict}(95th=${result.mdd_95th})`)
    }
  }

  return results.join(', ')
}

export async function runWeeklyPBO(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/backtest/pbo?partitions=10&source=backtest', {
    method: 'POST',
    timeoutMs: 120_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
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

async function triggerUniversalRetrainModal(
  env: Bindings,
  body: Record<string, unknown>,
  taskId: string,
): Promise<string> {
  requireController(env)

  const resp = await controllerFetch(env, '/retrain/universal/run', {
    method: 'POST',
    jsonBody: body,
    timeoutMs: 60_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`Controller /retrain/universal/run HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status === 'skipped') {
    return `${taskId} skipped: ${result.reason ?? 'locked'}`
  }
  if (result.status === 'failed' || result.status === 'error') {
    return `${taskId} failed: ${result.error ?? result.status}`
  }
  const runId = String(result.run_id ?? 'unknown')
  const functionCallId = String(result.function_call_id ?? result.execution_id ?? 'unknown')
  return `${taskId} triggered via Modal prep run_id=${runId} function_call_id=${functionCallId} callback expected`
}

const ACTIVE_WEEKLY_DRIFT_MODEL_NAMES = new Set([
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
  'TimesFM',
])

const MODEL_GROUP_BY_NAME: Record<string, string | null> = {
  XGBoost: 'tree',
  ExtraTrees: 'tree',
  LightGBM: 'tree',
  TabM: null,
  GNN: null,
  DLinear: 'dlinear',
  PatchTST: 'patchtst',
  iTransformer: null,
  TimesFM: null,
}

const FORMAL_ARTIFACT_LIFECYCLE_BY_NAME: Record<string, string> = {
  TabM: 'tabular_neural_artifact_retrain_registration',
  GNN: 'graphsage_full_universe_artifact_retrain_registration',
  PatchTST: 'sequence_artifact_retrain_registration',
  iTransformer: 'sequence_artifact_retrain_registration',
  TimesFM: 'foundation_forecast_validation_config_refresh',
}

function isWeeklyDriftTarget(model: Record<string, any>): boolean {
  const status = String(model.status ?? '').toLowerCase()
  const lastIcStatus = String(model.last_ic_status ?? '').toLowerCase()
  const ic4w = Number(model.ic_4w_avg ?? 0)
  const negWeeks = Number(model.consecutive_negative_weeks ?? 0)
  return (
    status === 'degraded' ||
    negWeeks > 0 ||
    lastIcStatus.includes('weak') ||
    lastIcStatus.includes('negative') ||
    lastIcStatus.includes('degraded') ||
    ic4w < 0
  )
}

export async function runWeeklyDriftRetrain(env: Bindings, runDate?: string) {
  requireController(env)

  const pool = await controllerJson<any>(env, '/model_pool/status', { timeoutMs: 30_000 })
  const models = pool?.models && typeof pool.models === 'object' ? pool.models as Record<string, Record<string, any>> : {}
  const targets = Object.entries(models)
    .filter(([name, model]) => ACTIVE_WEEKLY_DRIFT_MODEL_NAMES.has(name) && isWeeklyDriftTarget(model))
    .map(([name, model]) => {
      const hasMappedGroup = Object.prototype.hasOwnProperty.call(MODEL_GROUP_BY_NAME, name)
      return {
        name,
        family: String(model.balance_family ?? model.model_type ?? 'unknown'),
        group: hasMappedGroup ? MODEL_GROUP_BY_NAME[name] : 'tree',
        artifactLifecycle: FORMAL_ARTIFACT_LIFECYCLE_BY_NAME[name] ?? null,
        status: String(model.status ?? 'unknown'),
        ic4w: model.ic_4w_avg ?? null,
        consecutiveNegativeWeeks: Number(model.consecutive_negative_weeks ?? 0),
        lastIcStatus: model.last_ic_status ?? null,
      }
    })

  if (targets.length === 0) {
    return 'weekly_drift skipped: no degraded/weak model family; monthly release remains owner'
  }

  const retrainTargets = targets.filter((target) => target.group)
  const artifactLifecycleTargets = targets.filter((target) => !target.group && target.artifactLifecycle)
  const trainModelGroups = [
    ...new Set(retrainTargets.map((target) => target.group).filter((group): group is string => Boolean(group))),
  ]
  if (trainModelGroups.length === 0) {
    return `weekly_drift skipped: no supported retrain groups; artifact lifecycle targets=${artifactLifecycleTargets.map((target) => `${target.name}:${target.artifactLifecycle}`).join(',') || 'none'}`
  }
  const body = {
    limit: 2500,
    force_monthly: false,
    candidate_type: 'weekly_drift',
    run_date: runDate,
    train_model_groups: trainModelGroups,
    drift_target_models: retrainTargets.map((target) => target.name),
    drift_target_families: [...new Set(retrainTargets.map((target) => target.family))],
    artifact_lifecycle_targets: artifactLifecycleTargets.map((target) => target.name),
    artifact_lifecycle_contracts: Object.fromEntries(
      artifactLifecycleTargets.map((target) => [target.name, target.artifactLifecycle]),
    ),
    trigger_source: 'worker_weekly_drift',
  }
  if (universalRetrainModalTriggerEnabled(env)) {
    return triggerUniversalRetrainModal(env, body, 'weekly_drift retrain')
  }

  controllerFetch(env, '/retrain/universal', {
    method: 'POST',
    jsonBody: body,
    timeoutMs: 0,
  }).catch((e) => console.error('[weekly-drift-retrain] fire-and-forget error:', e))

  return `weekly_drift retrain triggered; candidate_type=weekly_drift; groups=${trainModelGroups.join(',')}; targets=${targets.map((target) => target.name).join(',')}; callback expected`
}

export async function triggerRetrain(env: Bindings, forceMonthly: boolean, taskId = forceMonthly ? 'monthly-retrain' : 'retrain') {
  requireController(env)

  const body = {
    limit: 2500,
    force_monthly: forceMonthly,
    train_model_groups: ['tree', 'dlinear', 'patchtst'],
    artifact_lifecycle_targets: ['GNN', 'TabM', 'PatchTST', 'iTransformer', 'TimesFM'],
    artifact_lifecycle_contracts: {
      GNN: FORMAL_ARTIFACT_LIFECYCLE_BY_NAME.GNN,
      TabM: FORMAL_ARTIFACT_LIFECYCLE_BY_NAME.TabM,
      PatchTST: FORMAL_ARTIFACT_LIFECYCLE_BY_NAME.PatchTST,
      iTransformer: FORMAL_ARTIFACT_LIFECYCLE_BY_NAME.iTransformer,
      TimesFM: FORMAL_ARTIFACT_LIFECYCLE_BY_NAME.TimesFM,
    },
    trigger_source: forceMonthly ? 'worker_monthly_retrain' : 'worker_retrain',
  }
  if (universalRetrainModalTriggerEnabled(env)) {
    return triggerUniversalRetrainModal(env, body, taskId)
  }

  controllerFetch(env, '/retrain/universal', {
    method: 'POST',
    jsonBody: body,
    timeoutMs: 0,
  }).catch((e) => console.error('[retrain] fire-and-forget error:', e))

  return `${taskId} triggered (force_monthly=${forceMonthly}); callback expected from Modal retrain followup`
}
