import type { Bindings } from '../types'
import { controllerFetch, controllerPostJson } from './controllerClient'

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
  const summary = `optuna research Job triggered cadence=${options.cadence} execution_id=${executionId || 'unknown'} callback expected`

  if ((env as any).DISCORD_WEBHOOK_URL) {
    const { sendDiscordNotification } = await import('./notify')
    await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL, `${options.cadence} Optuna research triggered\n${summary}`)
  }

  return `triggered ${summary}`
}

export async function runWeeklyOptunaResearch(env: Bindings) {
  return runOptunaResearch(env, {
    cadence: 'weekly',
    nTrials: 80,
    subsetSize: 400,
    ga: {
      populationSize: 12,
      generations: 4,
    },
  })
}

export async function runMonthlyOptunaResearch(env: Bindings) {
  return runOptunaResearch(env, {
    cadence: 'monthly',
    nTrials: 300,
    subsetSize: 1500,
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

export function summarizeWeeklyValidationChain(results: {
  backtest: string
  monteCarlo: string
  pbo: string
}): string {
  const summary = `bt(${results.backtest}) | mc(${results.monteCarlo}) | pbo(${results.pbo})`
  const failed = Object.entries(results)
    .filter(([, value]) => isFailureSummary(value))
    .map(([key, value]) => `${key}:${value}`)
  if (failed.length > 0) {
    throw new Error(`weekly validation chain failed: ${failed.join(' | ')}`)
  }
  return summary
}

export async function runOptunaQueueProcessor(env: Bindings) {
  requireController(env)

  const { popNextPending, markProcessed, markFailed } = await import('./optunaQueue')
  const entry = await popNextPending(env.KV)
  if (!entry) return 'empty'

  try {
    const isPerRegime = entry.target === 'per_regime'
    const endpoint = isPerRegime ? '/optuna/per_regime' : `/optuna/${entry.target}`
    const body = isPerRegime
      ? { target: 'sltp', n_trials: 50, subset_size: 200, window_days: 365, push_kv: true, dry_run: false }
      : { n_trials: 200, push_kv: true, dry_run: false }

    const resp = await controllerFetch(env, endpoint, {
      method: 'POST',
      jsonBody: body,
      timeoutMs: 3_500_000,
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

    await markProcessed(env.KV, entry.id, {
      sandbox_id: sandboxId,
      note: `robust_sharpe=${data.robust_sharpe ?? 'n/a'}`,
    })
    return `processed: ${entry.id}${sandboxId ? ` sandbox=${sandboxId.slice(-12)}` : ''}`
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    await markFailed(env.KV, entry.id, msg)
    return `failed: ${entry.id} ${msg.slice(0, 100)}`
  }
}

export async function runWeeklyLifecycleCheck(env: Bindings) {
  requireController(env)

  const resp = await controllerFetch(env, '/model_pool/promote_check', {
    method: 'POST',
    jsonBody: { apply: true, confirm: true },
    timeoutMs: 60_000,
  }).catch(() => null)
  if (!resp?.ok) return 'failed'

  const result = await resp.json() as Record<string, any>
  if (result.status === 'failed' || result.status === 'error') return `failed: ${result.error ?? result.status}`

  const transitions = (result.actions ?? [])
    .filter((action: any) => !String(action.transition ?? '').endsWith('_blocked'))
    .map((action: any) => `${action.model}:${action.transition}`)
    .join(',') || 'none'
  return `model_pool applied=${result.applied_count ?? 0}/${result.actions_count ?? 0} [${transitions}]`
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

export async function triggerRetrain(env: Bindings, forceMonthly: boolean, taskId = forceMonthly ? 'monthly-retrain' : 'retrain') {
  requireController(env)

  controllerFetch(env, '/retrain/universal', {
    method: 'POST',
    jsonBody: { limit: 2500, force_monthly: forceMonthly },
    timeoutMs: 0,
  }).catch((e) => console.error('[retrain] fire-and-forget error:', e))

  return `${taskId} triggered (force_monthly=${forceMonthly}); callback expected from Modal retrain followup`
}
