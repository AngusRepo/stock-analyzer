import type { Bindings } from '../types'
import { controllerFetch, controllerJson, controllerPostJson } from './controllerClient'

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

  const resp = await controllerFetch(env, '/config_pool/parameter_candidates/validation_chain', {
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
    timeoutMs: 120_000,
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`parameter candidate validation HTTP${resp.status}${text ? `(${text.slice(0, 300)})` : ''}`)
  }
  const result = text ? JSON.parse(text) as Record<string, any> : {}
  if (result.status === 'failed' || result.status === 'error') {
    throw new Error(`parameter candidate validation failed: ${result.reason ?? result.error ?? result.status}`)
  }
  return `candidate_validation status=${result.status ?? 'completed'} total=${result.total ?? 0} ready=${result.ready ?? 0} blocked=${result.blocked ?? 0}`
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

export async function runWeeklyModelArtifactValidation(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/model_pool/artifact_registry/validation_chain', {
    method: 'POST',
    jsonBody: { limit: 200, persist: true },
    timeoutMs: 120_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`
  return `artifacts=${result.count ?? 0}, updated=${result.updated ?? 0}, ready=${result.ready ?? 0}, blocked=${result.blocked ?? 0}`
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

const MODEL_GROUP_BY_NAME: Record<string, string> = {
  XGBoost: 'tree',
  CatBoost: 'tree',
  ExtraTrees: 'tree',
  LightGBM: 'tree',
  'FT-Transformer': 'ftt',
  Chronos: 'chronos',
  DLinear: 'dlinear',
  PatchTST: 'patchtst',
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
    .filter(([, model]) => isWeeklyDriftTarget(model))
    .map(([name, model]) => ({
      name,
      family: String(model.balance_family ?? model.model_type ?? 'unknown'),
      group: MODEL_GROUP_BY_NAME[name] ?? 'tree',
      status: String(model.status ?? 'unknown'),
      ic4w: model.ic_4w_avg ?? null,
      consecutiveNegativeWeeks: Number(model.consecutive_negative_weeks ?? 0),
      lastIcStatus: model.last_ic_status ?? null,
    }))

  if (targets.length === 0) {
    return 'weekly_drift skipped: no degraded/weak model family; monthly release remains owner'
  }

  const trainModelGroups = [...new Set(targets.map((target) => target.group))]
  controllerFetch(env, '/retrain/universal', {
    method: 'POST',
    jsonBody: {
      limit: 2500,
      force_monthly: false,
      candidate_type: 'weekly_drift',
      run_date: runDate,
      train_model_groups: trainModelGroups,
      drift_target_models: targets.map((target) => target.name),
      drift_target_families: [...new Set(targets.map((target) => target.family))],
    },
    timeoutMs: 0,
  }).catch((e) => console.error('[weekly-drift-retrain] fire-and-forget error:', e))

  return `weekly_drift retrain triggered; candidate_type=weekly_drift; groups=${trainModelGroups.join(',')}; targets=${targets.map((target) => target.name).join(',')}; callback expected`
}

export async function triggerRetrain(env: Bindings, forceMonthly: boolean, taskId = forceMonthly ? 'monthly-retrain' : 'retrain') {
  requireController(env)

  controllerFetch(env, '/retrain/universal', {
    method: 'POST',
    jsonBody: { limit: 2500, force_monthly: forceMonthly },
    timeoutMs: 0,
  }).catch((e) => console.error('[retrain] fire-and-forget error:', e))

  return `${taskId} triggered (force_monthly=${forceMonthly}); callback expected from Modal retrain followup`
}
