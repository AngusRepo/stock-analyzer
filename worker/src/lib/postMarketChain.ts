import type { Bindings } from '../types'
import { runAdaptiveUpdate, runLinUcbRewardLedgerRefresh } from './adaptiveEngine'
import { runArtifactAutoPromotion, runModelIcRollingRefresh, runObsidianDaily, runPaperActivePostmarketPromotion, runVerifyV2 } from './controllerWorkflows'
import { generateDailyReport } from './dailyReport'
import { ensureMetaLearningResearchRegistry } from './metaLearningResearchTrack'
import { runNeuralMetaShadow } from './metaLearningShadowRunner'
import { listLinUcbRewardSourceRows } from './metaLearningRewardLedger'
import { clearOpenPositionIntradayPriceCache } from './paperIntradayPriceCache'
import { classifySchedulerSummary, logSchedulerResult, type SchedulerRunStatus } from './schedulerRunLogger'
import { recordWorkerTaskComputeProfile } from './computeProfileEvents'
import { runAllocatorEvFeatureSnapshotBackfill } from './controllerResearchWorkflows'
import {
  inspectAllocatorSnapshotClosure,
  recordAllocatorEvLifecycle,
} from './allocatorEvDailyLifecycle'
import { claimPipelineStage, enqueuePipelineStage, markPipelineStage } from './pipelineStageLease'
import { materializePriceHorizonLabels } from './priceHorizonProjection'

export type ChainContext = {
  runDate?: string
  upstreamRunId?: string
  recoveryAttempt?: number
}

export function resolveChainAttemptId(ctx: ChainContext): string | undefined {
  if (!ctx.upstreamRunId && ctx.recoveryAttempt == null) return undefined
  const owner = ctx.upstreamRunId || ctx.runDate || 'post-market-callback'
  const attempt = Math.max(0, Math.floor(Number(ctx.recoveryAttempt ?? 0)))
  return `${owner}:attempt-${attempt}`
}

type ChainedTask = {
  task: string
  summary: string
  status: SchedulerRunStatus
  critical?: boolean
}

const TASK_OBSERVABILITY_TIMEOUT_MS = 5_000
const TASK_EXECUTION_TIMEOUT_MS = 25_000
const META_SHADOW_POLICY_TIMEOUT_MS = 180_000

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

async function withTaskExecutionTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
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
      attempt_id: resolveChainAttemptId(ctx),
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
  options: { critical?: boolean; timeoutMs?: number } = {},
): Promise<ChainedTask> {
  const t0 = Date.now()
  const critical = options.critical !== false
  try {
    const rawSummary = options.timeoutMs
      ? await withTaskExecutionTimeout(task, fn(), options.timeoutMs)
      : await fn()
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
    attempt_id: resolveChainAttemptId(ctx),
    run_date: ctx.runDate,
  }, env)
  return { task, summary, status: 'skipped' }
}

export async function runMetaLearningShadowClosure(env: Bindings, ctx: ChainContext): Promise<string> {
  const registry = await ensureMetaLearningResearchRegistry(env.KV)
  const sourceRows = await listLinUcbRewardSourceRows(env.DB, {
    endDate: ctx.runDate,
    limit: 5000,
  })
  const [neuralUcb, neuralTs, neuCb] = await Promise.all([
    runNeuralMetaShadow(env, {
      policyId: 'NeuralUCB',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: META_SHADOW_POLICY_TIMEOUT_MS,
      sourceRows,
    }),
    runNeuralMetaShadow(env, {
      policyId: 'NeuralTS',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: META_SHADOW_POLICY_TIMEOUT_MS,
      sourceRows,
    }),
    runNeuralMetaShadow(env, {
      policyId: 'NeuCB',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: META_SHADOW_POLICY_TIMEOUT_MS,
      sourceRows,
    }),
  ])
  return [
    `registry_created=${registry.created.length}`,
    `registry_total=${registry.total}`,
    `neural_ucb=${normalizeSummary(neuralUcb)}`,
    `neural_ts=${normalizeSummary(neuralTs)}`,
    `neucb=${normalizeSummary(neuCb)}`,
  ].join(' ')
}

async function enqueueMetaLearningShadowClosureTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const runId = ctx.upstreamRunId || `meta-learning-shadow-${runDate}-${Date.now()}`
  await env.UPDATE_QUEUE.send({
    type: 'meta_learning_shadow_closure',
    cursor: 0,
    triggerTime: runDate,
    runId,
    force: isCurrentBusinessDate(runDate),
  })
  return `triggered meta-learning-shadow queue run_date=${runDate} run_id=${runId}`
}

async function enqueueStrategyLearningClosureTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const runId = ctx.upstreamRunId || `strategy-learning-${runDate}-${Date.now()}`
  await env.UPDATE_QUEUE.send({
    type: 'strategy_learning_materialize',
    cursor: 0,
    cursorKey: '',
    triggerTime: runDate,
    runId,
    force: isCurrentBusinessDate(runDate),
  })
  return `triggered strategy-learning queue run_date=${runDate} run_id=${runId}`
}

async function enqueueS12ReplayBackfillTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const { loadReplayReadySignalDates } = await import('./s12ReplayTradeOutcome')
  const signalDates = await loadReplayReadySignalDates(env.DB, runDate, 5)
  for (const signalDate of signalDates) {
    const runId = `${ctx.upstreamRunId || 'post-verify'}-s12-${signalDate}-${Date.now()}`
    await env.UPDATE_QUEUE.send({
      type: 's12_replay_backfill_chunk',
      cursor: 0,
      triggerTime: signalDate,
      runId,
      replayScope: 'fusion_snapshot_missing',
      maturityAsOfDate: runDate,
      statusRunDate: runDate,
    } as any)
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate: signalDate,
      state: 'replay_enqueued',
      replayMaturityAsOfDate: runDate,
      upstreamRunId: runId,
    })
  }
  await recordAllocatorEvLifecycle(env.DB, {
    businessDate: runDate,
    state: 'replay_pending_maturity',
    upstreamRunId: ctx.upstreamRunId,
  })
  return signalDates.length
    ? `triggered next-session S12 replay signal_dates=${signalDates.join(',')} as_of=${runDate}`
    : `next-session S12 replay current as_of=${runDate}`
}

async function logChainSummary(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  startedAt: number,
  results: ChainedTask[],
): Promise<void> {
  const hasError = results.some((row) => row.critical !== false && row.status === 'error')
  const waitingForQueuedStrategyLearning = task === 'post-verify-chain'
    && results.some((row) => row.task === 'strategy-learning' && row.status === 'triggered')
  const summary = results.map((row) => `${row.task}:${row.status}`).join(' ')
  const status = hasError ? 'error' : waitingForQueuedStrategyLearning ? 'running' : 'success'
  await logSchedulerResult(env.KV, task, {
    status,
    summary: waitingForQueuedStrategyLearning
      ? `waiting for queued strategy-learning: ${summary || 'success'}`
      : summary || 'success',
    duration_ms: Date.now() - startedAt,
    run_id: ctx.upstreamRunId,
    attempt_id: resolveChainAttemptId(ctx),
    run_date: ctx.runDate,
  }, env)
  if (task === 'post-verify-chain') {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status,
      summary: waitingForQueuedStrategyLearning
        ? `root chain waiting for queued strategy-learning: ${summary || 'success'}`
        : `root chain closed after post-verify: ${summary || 'success'}`,
      duration_ms: Date.now() - startedAt,
      run_id: ctx.upstreamRunId,
      attempt_id: resolveChainAttemptId(ctx),
      run_date: ctx.runDate,
    }, env)
  }
}

export async function runPostPipelineCallbackChain(
  env: Bindings,
  ctx: ChainContext,
): Promise<'waiting' | 'success' | 'error'> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []

  if (ctx.runDate) {
    await env.KV.delete(`lock:ml-predict:${ctx.runDate}`).catch(() => {})
  }

  if (!ctx.runDate) {
    results.push({
      task: 'allocator-ev-feature-snapshot-backfill',
      summary: 'pipeline callback missing run date',
      status: 'error',
      critical: true,
    })
    await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
    return 'error'
  }
  let snapshotClosure = await inspectAllocatorSnapshotClosure(env.DB, ctx.runDate, { kv: env.KV })
  await recordAllocatorEvLifecycle(env.DB, {
    businessDate: ctx.runDate,
    state: 'lineage_ready',
    nativeLineageRows: snapshotClosure.nativeLineageRows,
    upstreamRunId: ctx.upstreamRunId,
    incrementAttempt: true,
  })
  const snapshotAttempt = Math.max(0, Number(ctx.recoveryAttempt ?? 0))
  if (!snapshotClosure.ready && snapshotAttempt >= 3) {
    const error = `allocator snapshot retry budget exhausted attempt=${snapshotAttempt} `
      + `native=${snapshotClosure.runNativeLineageRows} reconstructed=${snapshotClosure.reconstructedLineageRows} `
      + `rejected=${snapshotClosure.rejectedLineageRows} expected=${snapshotClosure.expectedRows} `
      + `published=${snapshotClosure.publishedRows} actual=${snapshotClosure.actualRows}`
    results.push({
      task: 'allocator-ev-feature-snapshot-backfill',
      summary: error,
      status: 'error',
      critical: true,
    })
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate: ctx.runDate,
      state: 'error',
      nativeLineageRows: snapshotClosure.nativeLineageRows,
      snapshotRunId: snapshotClosure.snapshotRunId,
      snapshotRows: snapshotClosure.actualRows,
      upstreamRunId: ctx.upstreamRunId,
      lastError: error,
    })
    await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
    return 'error'
  }
  const snapshotTask = await logChainedTask(
    env,
    ctx,
    'allocator-ev-feature-snapshot-backfill',
    () => snapshotClosure.ready
      ? Promise.resolve(`allocator snapshot already ready date=${ctx.runDate} rows=${snapshotClosure.actualRows}`)
      : runAllocatorEvFeatureSnapshotBackfill(env, {
        startDate: ctx.runDate!,
        endDate: ctx.runDate!,
        dryRun: false,
        candidateLimit: 1000,
        l4MinSamples: 500,
        l4MinDates: 20,
        runId: ctx.upstreamRunId,
      }),
    { timeoutMs: 330_000 },
  )
  results.push(snapshotTask)
  const snapshotPending = snapshotTask.status !== 'error'
    && /\bstatus=(?:spawned|pending)\b/i.test(snapshotTask.summary)
  if (snapshotPending) {
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate: ctx.runDate,
      state: 'lineage_ready',
      nativeLineageRows: snapshotClosure.nativeLineageRows,
      upstreamRunId: ctx.upstreamRunId,
    })
    await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
    return 'waiting'
  }
  snapshotClosure = await inspectAllocatorSnapshotClosure(env.DB, ctx.runDate, { kv: env.KV })
  if (snapshotTask.status === 'error' || !snapshotClosure.ready) {
    const error = snapshotTask.status === 'error'
      ? snapshotTask.summary
      : `snapshot readback incomplete native=${snapshotClosure.runNativeLineageRows} `
        + `reconstructed=${snapshotClosure.reconstructedLineageRows} rejected=${snapshotClosure.rejectedLineageRows} `
        + `expected=${snapshotClosure.expectedRows} published=${snapshotClosure.publishedRows} actual=${snapshotClosure.actualRows}`
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate: ctx.runDate,
      state: 'error',
      nativeLineageRows: snapshotClosure.nativeLineageRows,
      snapshotRunId: snapshotClosure.snapshotRunId,
      snapshotRows: snapshotClosure.actualRows,
      upstreamRunId: ctx.upstreamRunId,
      lastError: error,
    })
    const attempt = snapshotAttempt
    const retryScheduled = attempt < 3
    if (attempt < 3) {
      await (env.UPDATE_QUEUE as any).send({
        type: 'allocator_ev_lifecycle_recovery',
        cursor: 0,
        triggerTime: ctx.runDate,
        runId: ctx.upstreamRunId,
        attempt: attempt + 1,
      }, { delaySeconds: Math.min(900, 60 * (2 ** attempt)) })
    }
    await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
    return retryScheduled ? 'waiting' : 'error'
  }
  await recordAllocatorEvLifecycle(env.DB, {
    businessDate: ctx.runDate,
    state: 'snapshot_ready',
    nativeLineageRows: snapshotClosure.nativeLineageRows,
    snapshotRunId: snapshotClosure.snapshotRunId,
    snapshotRows: snapshotClosure.actualRows,
    upstreamRunId: ctx.upstreamRunId,
  })
  const verifyStage = await enqueuePipelineStage(env.DB, {
    businessDate: ctx.runDate,
    stage: 'verify_v2',
    runId: ctx.upstreamRunId || `verify-v2-${ctx.runDate}`,
    resumeWaiting: true,
    supersedeSuccess: true,
  })
  let verifyTask: ChainedTask
  if (!verifyStage.shouldEnqueue) {
    verifyTask = {
      task: 'verify-v2',
      status: 'success',
      critical: true,
      summary: `verify stage already status=${verifyStage.row.status} run_id=${verifyStage.row.canonical_run_id}`,
    }
  } else {
    const claimed = await claimPipelineStage(env.DB, {
      businessDate: ctx.runDate,
      stage: 'verify_v2',
      ownerId: verifyStage.row.canonical_run_id,
      leaseSeconds: 120,
    })
    verifyTask = claimed
      ? await logChainedTask(
        env,
        ctx,
        'verify-v2',
        () => runVerifyV2(
          env,
          ctx.runDate,
          `verify_v2:${ctx.runDate}:${snapshotClosure.snapshotRunId}`,
        ),
      )
      : {
        task: 'verify-v2',
        status: 'success',
        critical: true,
        summary: 'verify stage was claimed by another worker',
      }
    if (claimed) {
      await markPipelineStage(env.DB, {
        businessDate: ctx.runDate,
        stage: 'verify_v2',
        status: verifyTask.status === 'error' ? 'error' : 'waiting',
        error: verifyTask.status === 'error' ? verifyTask.summary : null,
      })
    }
  }
  results.push(verifyTask)
  if (verifyTask.status !== 'error') {
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate: ctx.runDate,
      state: 'verify_triggered',
      nativeLineageRows: snapshotClosure.nativeLineageRows,
      snapshotRunId: snapshotClosure.snapshotRunId,
      snapshotRows: snapshotClosure.actualRows,
      upstreamRunId: ctx.upstreamRunId,
    })
  }
  await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
  return verifyTask.status === 'error' ? 'error' : 'success'
}

export async function runPostVerifyCallbackChain(
  env: Bindings,
  ctx: ChainContext,
): Promise<'success' | 'error'> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []

  const projectionTask = await logChainedTask(env, ctx, 'price-horizon-projection', async () => {
    const result = await materializePriceHorizonLabels(env, {
      endDate: ctx.runDate,
      outcomeAsOfDate: twDateToday(),
      maxSignalDates: 60,
      maxProcessDates: 8,
    })
    return result.summary
  }, { timeoutMs: 240_000 })
  results.push(projectionTask)
  if (projectionTask.status === 'error') {
    await logChainSummary(env, ctx, 'post-verify-chain', startedAt, results)
    return 'error'
  }

  results.push(await logChainedTask(env, ctx, 'model-ic-rolling', () => runModelIcRollingRefresh(env, ctx.runDate)))
  if (isCurrentBusinessDate(ctx.runDate)) {
    results.push(await logChainedTask(env, ctx, 'artifact-auto-promotion', () => runArtifactAutoPromotion(env), { critical: false }))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'artifact-auto-promotion'))
  }
  results.push(await logChainedTask(env, ctx, 's12-replay-backfill', () => enqueueS12ReplayBackfillTask(env, ctx), {
    timeoutMs: TASK_EXECUTION_TIMEOUT_MS,
  }))

  if (isCurrentBusinessDate(ctx.runDate)) {
    results.push(await logChainedTask(env, ctx, 'paper-intraday-cache-clear', () => clearOpenPositionIntradayPriceCache(env), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh(env, ctx.runDate)))
    results.push(await logChainedTask(env, ctx, 'adapt', () => runAdaptiveUpdate(env, { refreshLedger: false })))
    results.push(await logChainedTask(env, ctx, 'daily-report', () => generateDailyReport(env)))
    results.push(await logChainedTask(env, ctx, 'paper-active-postmarket', () => runPaperActivePostmarketPromotion(env, ctx.runDate), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'obsidian-sync', () => runObsidianDaily(env, ctx.runDate!)))
    results.push(await logChainedTask(env, ctx, 'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask(env, ctx), {
      critical: false,
      timeoutMs: TASK_EXECUTION_TIMEOUT_MS,
    }))
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
  results.push(await logChainedTask(env, ctx, 'strategy-learning', () => enqueueStrategyLearningClosureTask(env, ctx), {
    critical: true,
    timeoutMs: TASK_EXECUTION_TIMEOUT_MS,
  }))

  await logChainSummary(env, ctx, 'post-verify-chain', startedAt, results)
  const criticalFailure = results.find((row) => row.critical !== false && row.status === 'error')
  if (criticalFailure) {
    throw new Error(`post_verify_chain_failed:${criticalFailure.task}:${criticalFailure.summary}`)
  }
  return 'success'
}
