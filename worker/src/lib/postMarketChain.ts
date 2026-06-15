import type { Bindings } from '../types'
import { runAdaptiveUpdate, runLinUcbRewardLedgerRefresh } from './adaptiveEngine'
import { runModelIcRollingRefresh, runObsidianDaily, runPaperActivePostmarketPromotion, runVerifyV2 } from './controllerWorkflows'
import { generateDailyReport } from './dailyReport'
import { ensureMetaLearningResearchRegistry } from './metaLearningResearchTrack'
import { runNeuralMetaShadow } from './metaLearningShadowRunner'
import { clearOpenPositionIntradayPriceCache } from './paperIntradayPriceCache'
import { classifySchedulerSummary, logSchedulerResult, type SchedulerRunStatus } from './schedulerRunLogger'
import { recordWorkerTaskComputeProfile } from './computeProfileEvents'

type ChainContext = {
  runDate?: string
  upstreamRunId?: string
}

type ChainedTask = {
  task: string
  summary: string
  status: SchedulerRunStatus
  critical?: boolean
}

const TASK_OBSERVABILITY_TIMEOUT_MS = 5_000

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

async function withObservabilityTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${TASK_OBSERVABILITY_TIMEOUT_MS}ms`)),
          TASK_OBSERVABILITY_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function emitChainedTaskObservability(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  status: SchedulerRunStatus,
  summary: string,
  durationMs: number,
  error?: string,
): Promise<void> {
  const results = await Promise.allSettled([
    withObservabilityTimeout(`${task} scheduler log`, logSchedulerResult(env.KV, task, {
      status,
      summary,
      duration_ms: durationMs,
      error,
      run_id: ctx.upstreamRunId,
      run_date: ctx.runDate,
    }, env)),
    withObservabilityTimeout(`${task} compute profile`, recordWorkerTaskComputeProfile(env, {
      task,
      status,
      durationMs,
      runDate: ctx.runDate,
      runId: ctx.upstreamRunId,
      chain: 'post_market_callback',
    })),
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(`[postMarketChain] ${task} observability write failed:`, result.reason)
    }
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
    await emitChainedTaskObservability(env, ctx, task, status, summary, durationMs)
    return { task, summary, status, critical }
  } catch (e: any) {
    const summary = e?.message ?? `${task} failed`
    const durationMs = Date.now() - t0
    await emitChainedTaskObservability(env, ctx, task, 'error', summary, durationMs, String(e))
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
  const neuralUcb = await runNeuralMetaShadow(env, {
    policyId: 'NeuralUCB',
    endDate: ctx.runDate,
    dryRun: false,
    timeoutMs: 45_000,
  })
  const neuralTs = await runNeuralMetaShadow(env, {
    policyId: 'NeuralTS',
    endDate: ctx.runDate,
    dryRun: false,
    timeoutMs: 45_000,
  })
  const neuCb = await runNeuralMetaShadow(env, {
    policyId: 'NeuCB',
    endDate: ctx.runDate,
    dryRun: false,
    timeoutMs: 45_000,
  })
  return [
    `registry_created=${registry.created.length}`,
    `registry_total=${registry.total}`,
    `neural_ucb=${normalizeSummary(neuralUcb)}`,
    `neural_ts=${normalizeSummary(neuralTs)}`,
    `neucb=${normalizeSummary(neuCb)}`,
  ].join(' ')
}

async function runStrategyLearningClosureTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const { runStrategyLearningClosure } = await import('./strategyLearning')
  return runStrategyLearningClosure(
    env.DB,
    ctx.runDate ?? new Date().toISOString().slice(0, 10),
    { persistPolicy: isCurrentBusinessDate(ctx.runDate) },
  )
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
  if (task === 'post-verify-chain') {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: hasError ? 'error' : 'success',
      summary: `root chain closed after post-verify: ${summary || 'success'}`,
      duration_ms: Date.now() - startedAt,
      run_id: ctx.upstreamRunId,
      run_date: ctx.runDate,
    }, env)
  }
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

  if (isCurrentBusinessDate(ctx.runDate)) {
    results.push(await logChainedTask(env, ctx, 'paper-intraday-cache-clear', () => clearOpenPositionIntradayPriceCache(env), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh(env, ctx.runDate)))
    results.push(await logChainedTask(env, ctx, 'adapt', () => runAdaptiveUpdate(env, { refreshLedger: false })))
    results.push(await logChainedTask(env, ctx, 'daily-report', () => generateDailyReport(env)))
    results.push(await logChainedTask(env, ctx, 'paper-active-postmarket', () => runPaperActivePostmarketPromotion(env, ctx.runDate), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'obsidian-sync', () => runObsidianDaily(env, ctx.runDate!)))
    results.push(await logChainedTask(env, ctx, 'meta-learning-shadow', () => runMetaLearningShadowClosure(env, ctx), { critical: false }))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'linucb-reward-ledger'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'paper-intraday-cache-clear'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'adapt'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'daily-report'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'paper-active-postmarket'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'obsidian-sync'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'meta-learning-shadow'))
  }

  // Strategy learning is evidence materialization, not a live trading mutation.
  // Historical reruns need it so strategy_decision_log can explain family/variant
  // ownership for the replayed business date.
  results.push(await logChainedTask(env, ctx, 'strategy-learning', () => runStrategyLearningClosureTask(env, ctx), { critical: false }))

  await logChainSummary(env, ctx, 'post-verify-chain', startedAt, results)
}
