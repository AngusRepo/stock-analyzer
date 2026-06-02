import type { Bindings } from '../types'
import { runAdaptiveUpdate, runLinUcbRewardLedgerRefresh } from './adaptiveEngine'
import { controllerPostJson } from './controllerClient'
import { runModelIcRollingRefresh, runObsidianDaily, runPaperActivePostmarketPromotion, runVerifyV2 } from './controllerWorkflows'
import { generateDailyReport } from './dailyReport'
import type { FinLabRawFactorMinerPayload } from './finlabAiSkillDiscovery'
import { ensureMetaLearningResearchRegistry } from './metaLearningResearchTrack'
import { runNeuralMetaShadow } from './metaLearningShadowRunner'
import { classifySchedulerSummary, logSchedulerResult, type SchedulerRunStatus } from './schedulerRunLogger'
import { recordWorkerTaskComputeProfile } from './computeProfileEvents'

type ChainContext = {
  runDate?: string
  upstreamRunId?: string
  metadata?: Record<string, unknown>
}

type ChainedTask = {
  task: string
  summary: string
  status: SchedulerRunStatus
  critical?: boolean
}

function twDateToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function normalizeSummary(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isCurrentBusinessDate(runDate?: string): boolean {
  return !!runDate && runDate === twDateToday()
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return false
}

function allowHistoricalLearningCatchup(ctx: ChainContext): boolean {
  return !isCurrentBusinessDate(ctx.runDate) && truthyFlag(ctx.metadata?.allow_historical_learning_catchup)
}

async function isLatestRecommendationBusinessDate(env: Bindings, runDate?: string): Promise<boolean> {
  if (!runDate || !env.DB) return false
  try {
    const row = await env.DB.prepare(`
      SELECT MAX(date) AS latest_date
        FROM daily_recommendations
       WHERE date IS NOT NULL
    `).first<{ latest_date: string | null }>()
    return row?.latest_date === runDate
  } catch {
    return false
  }
}

async function logChainedTask(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  fn: () => Promise<unknown>,
  options: { critical?: boolean } = {},
): Promise<ChainedTask> {
  const t0 = Date.now()
  const critical = options.critical !== false
  try {
    const rawSummary = await fn()
    const summary = normalizeSummary(rawSummary)
    const status = classifySchedulerSummary(summary)
    const durationMs = Date.now() - t0
    await logSchedulerResult(env.KV, task, {
      status,
      summary,
      duration_ms: durationMs,
      run_id: ctx.upstreamRunId,
      run_date: ctx.runDate,
    }, env)
    await recordWorkerTaskComputeProfile(env, {
      task,
      status,
      durationMs,
      runDate: ctx.runDate,
      runId: ctx.upstreamRunId,
      chain: 'post_market_callback',
    })
    return { task, summary, status, critical }
  } catch (e: any) {
    const summary = e?.message ?? `${task} failed`
    const durationMs = Date.now() - t0
    await logSchedulerResult(env.KV, task, {
      status: 'error',
      summary,
      duration_ms: durationMs,
      error: String(e),
      run_id: ctx.upstreamRunId,
      run_date: ctx.runDate,
    }, env)
    await recordWorkerTaskComputeProfile(env, {
      task,
      status: 'error',
      durationMs,
      runDate: ctx.runDate,
      runId: ctx.upstreamRunId,
      chain: 'post_market_callback',
    })
    return { task, summary, status: 'error', critical }
  }
}

async function logSkippedHistoricalTask(env: Bindings, ctx: ChainContext, task: string): Promise<ChainedTask> {
  const summary = `skipped historical callback run_date=${ctx.runDate ?? 'unknown'}; ${task} is current-date only`
  await logSchedulerResult(env.KV, task, {
    status: 'skipped',
    summary,
    duration_ms: 0,
    run_id: ctx.upstreamRunId,
    run_date: ctx.runDate,
  }, env)
  return { task, summary, status: 'skipped' }
}

async function runMetaLearningShadowClosure(env: Bindings, ctx: ChainContext): Promise<string> {
  const registry = await ensureMetaLearningResearchRegistry(env.KV)
  const [neuralUcb, neuralTs] = await Promise.all([
    runNeuralMetaShadow(env, {
      policyId: 'NeuralUCB',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: 45_000,
    }),
    runNeuralMetaShadow(env, {
      policyId: 'NeuralTS',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: 45_000,
    }),
  ])
  return [
    `registry_created=${registry.created.length}`,
    `registry_total=${registry.total}`,
    `neural_ucb=${normalizeSummary(neuralUcb)}`,
    `neural_ts=${normalizeSummary(neuralTs)}`,
  ].join(' ')
}

async function runStrategyLearningClosureTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const { runStrategyLearningClosure } = await import('./strategyLearning')
  return runStrategyLearningClosure(env.DB, ctx.runDate ?? new Date().toISOString().slice(0, 10))
}

async function dispatchPostVerifyLearningClosure(env: Bindings, ctx: ChainContext): Promise<string> {
  const runDate = ctx.runDate ?? twDateToday()
  const runId = ctx.upstreamRunId ?? `post-verify-learning-${runDate}-${Date.now()}`
  await env.UPDATE_QUEUE.send({
    type: 'post_verify_learning_closure',
    cursor: 0,
    triggerTime: runDate,
    runId,
    attempt: 1,
    metadata: {
      ...(ctx.metadata ?? {}),
      source: 'post_verify_callback_chain',
    },
  })
  return `post_verify_learning_closure_dispatched run_date=${runDate} run_id=${runId}`
}

export async function runPostVerifyLearningClosureQueueTask(env: Bindings, ctx: ChainContext): Promise<void> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []
  results.push(await logChainedTask(env, ctx, 'meta-learning-shadow', () => runMetaLearningShadowClosure(env, ctx), { critical: false }))
  results.push(await logChainedTask(env, ctx, 'finlab-ai-skill-discovery', () => runFinLabAiSkillDiscoveryClosureTask(env, ctx), { critical: false }))
  results.push(await logChainedTask(env, ctx, 'strategy-learning', () => runStrategyLearningClosureTask(env, ctx), { critical: false }))
  await logChainSummary(env, ctx, 'post-verify-learning-closure', startedAt, results)
}

async function fetchFinLabRawFactorMinerPayload(env: Bindings): Promise<{
  payload: FinLabRawFactorMinerPayload | null
  summary: string
}> {
  if (!env.ML_CONTROLLER_URL) {
    return { payload: null, summary: 'raw_factor_miner=skipped_no_ml_controller_url' }
  }
  try {
    const payload = await controllerPostJson<FinLabRawFactorMinerPayload>(
      env,
      '/finlab/ai-factor-discovery',
      { max_per_lane: 8, dry_run: false },
      120_000,
    )
    const count = Array.isArray(payload?.candidates) ? payload.candidates.length : 0
    return { payload, summary: `raw_factor_miner=ok candidates=${count}` }
  } catch (error) {
    return { payload: null, summary: `raw_factor_miner=unavailable:${String(error).slice(0, 160)}` }
  }
}

async function runFinLabAiSkillDiscoveryClosureTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const { runFinLabAiSkillDiscoveryClosure } = await import('./finlabAiSkillDiscovery')
  const rawFactorMiner = await fetchFinLabRawFactorMinerPayload(env)
  const report = await runFinLabAiSkillDiscoveryClosure(env, ctx.runDate ?? new Date().toISOString().slice(0, 10), {
    dryRun: false,
    rawFactorMinerPayload: rawFactorMiner.payload,
  })
  return [
    `status=${report.status}`,
    `source_rows=${report.source_rows}`,
    `packets=${report.packets.length}`,
    `research_experiments=${report.persisted.research_experiments}`,
    `strategy_specs=${report.persisted.strategy_specs}`,
    `invalid=${report.skipped_invalid.length}`,
    rawFactorMiner.summary,
    report.reason ? `reason=${report.reason}` : '',
  ].filter(Boolean).join(' ')
}

async function logChainSummary(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  startedAt: number,
  results: ChainedTask[],
): Promise<void> {
  const hasError = results.some((row) => row.critical !== false && row.status === 'error')
  const summary = results.map((row) => `${row.task}:${row.status}`).join(' ')
  await logSchedulerResult(env.KV, task, {
    status: hasError ? 'error' : 'success',
    summary: summary || 'success',
    duration_ms: Date.now() - startedAt,
    run_id: ctx.upstreamRunId,
    run_date: ctx.runDate,
  }, env)
}

export async function runPostPipelineCallbackChain(env: Bindings, ctx: ChainContext): Promise<void> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []

  if (ctx.runDate) {
    await env.KV.delete(`lock:ml-predict:${ctx.runDate}`).catch(() => {})
  }

  results.push(await logChainedTask(env, ctx, 'verify-v2', () => runVerifyV2(env, ctx.runDate)))
  await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
}

export async function runPostVerifyCallbackChain(env: Bindings, ctx: ChainContext): Promise<void> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []

  results.push(await logChainedTask(env, ctx, 'model-ic-tracker', () => runModelIcRollingRefresh(env, ctx.runDate)))

  const currentBusinessDate = isCurrentBusinessDate(ctx.runDate)
  const historicalLearningCatchup = allowHistoricalLearningCatchup(ctx)
  const latestRecommendationBusinessDate = await isLatestRecommendationBusinessDate(env, ctx.runDate)
  const runLearningClosures = currentBusinessDate || historicalLearningCatchup || latestRecommendationBusinessDate

  if (currentBusinessDate) {
    results.push(await logChainedTask(env, ctx, 'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh(env, ctx.runDate)))
    results.push(await logChainedTask(env, ctx, 'adapt', () => runAdaptiveUpdate(env, { refreshLedger: false })))
    results.push(await logChainedTask(env, ctx, 'daily-report', () => generateDailyReport(env)))
    results.push(await logChainedTask(env, ctx, 'paper-active-postmarket', () => runPaperActivePostmarketPromotion(env, ctx.runDate), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'obsidian-sync', () => runObsidianDaily(env, ctx.runDate!)))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'linucb-reward-ledger'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'adapt'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'daily-report'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'paper-active-postmarket'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'obsidian-sync'))
    if (!runLearningClosures) {
      results.push(await logSkippedHistoricalTask(env, ctx, 'meta-learning-shadow'))
    }
  }

  if (runLearningClosures) {
    results.push(await logChainedTask(env, ctx, 'post-verify-learning-dispatch', () => dispatchPostVerifyLearningClosure(env, ctx), { critical: false }))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'finlab-ai-skill-discovery'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'strategy-learning'))
  }

  await logChainSummary(env, ctx, 'post-verify-chain', startedAt, results)
}
