import type { Bindings } from '../types'
import { runAdaptiveUpdate, runLinUcbRewardLedgerRefresh } from './adaptiveEngine'
import { runModelIcRollingRefresh, runObsidianDaily, runRegimeCompute, runVerifyV2 } from './controllerWorkflows'
import { generateDailyReport } from './dailyReport'
import { ensureMetaLearningResearchRegistry } from './metaLearningResearchTrack'
import { runNeuralMetaShadow } from './metaLearningShadowRunner'
import { classifySchedulerSummary, logSchedulerResult, type SchedulerRunStatus } from './schedulerRunLogger'

type ChainContext = {
  runDate?: string
  upstreamRunId?: string
}

type ChainedTask = {
  task: string
  summary: string
  status: SchedulerRunStatus
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

async function logChainedTask(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  fn: () => Promise<unknown>,
): Promise<ChainedTask> {
  const t0 = Date.now()
  try {
    const rawSummary = await fn()
    const summary = normalizeSummary(rawSummary)
    const status = classifySchedulerSummary(summary)
    await logSchedulerResult(env.KV, task, {
      status,
      summary,
      duration_ms: Date.now() - t0,
      run_id: ctx.upstreamRunId,
      run_date: ctx.runDate,
    }, env)
    return { task, summary, status }
  } catch (e: any) {
    const summary = e?.message ?? `${task} failed`
    await logSchedulerResult(env.KV, task, {
      status: 'error',
      summary,
      duration_ms: Date.now() - t0,
      error: String(e),
      run_id: ctx.upstreamRunId,
      run_date: ctx.runDate,
    }, env)
    return { task, summary, status: 'error' }
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
  })
  const neuralTs = await runNeuralMetaShadow(env, {
    policyId: 'NeuralTS',
    endDate: ctx.runDate,
    dryRun: false,
  })
  return [
    `registry_created=${registry.created.length}`,
    `registry_total=${registry.total}`,
    `neural_ucb=${normalizeSummary(neuralUcb)}`,
    `neural_ts=${normalizeSummary(neuralTs)}`,
  ].join(' ')
}

async function logChainSummary(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  startedAt: number,
  results: ChainedTask[],
): Promise<void> {
  const hasError = results.some((row) => row.status === 'error')
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

  if (isCurrentBusinessDate(ctx.runDate)) {
    results.push(await logChainedTask(env, ctx, 'regime-compute', () => runRegimeCompute(env)))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'regime-compute'))
  }

  results.push(await logChainedTask(env, ctx, 'verify-v2', () => runVerifyV2(env, ctx.runDate)))
  await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
}

export async function runPostVerifyCallbackChain(env: Bindings, ctx: ChainContext): Promise<void> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []

  results.push(await logChainedTask(env, ctx, 'model-ic-tracker', () => runModelIcRollingRefresh(env, ctx.runDate)))

  if (isCurrentBusinessDate(ctx.runDate)) {
    results.push(await logChainedTask(env, ctx, 'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh(env, ctx.runDate)))
    results.push(await logChainedTask(env, ctx, 'meta-learning-shadow', () => runMetaLearningShadowClosure(env, ctx)))
    results.push(await logChainedTask(env, ctx, 'adapt', () => runAdaptiveUpdate(env, { refreshLedger: false })))
    results.push(await logChainedTask(env, ctx, 'daily-report', () => generateDailyReport(env)))
    results.push(await logChainedTask(env, ctx, 'obsidian-sync', () => runObsidianDaily(env, ctx.runDate!)))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'linucb-reward-ledger'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'meta-learning-shadow'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'adapt'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'daily-report'))
    results.push(await logSkippedHistoricalTask(env, ctx, 'obsidian-sync'))
  }

  await logChainSummary(env, ctx, 'post-verify-chain', startedAt, results)
}
