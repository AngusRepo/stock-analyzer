import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { runAdaptiveUpdate, runLinUcbRewardLedgerRefresh } from './adaptiveEngine'
import { expectedVerifyProducerRunId, runArtifactAutoPromotion, runModelIcRollingRefresh, runObsidianDaily, runPaperActivePostmarketPromotion, runVerifyV2 } from './controllerWorkflows'
import { generateDailyReport } from './dailyReport'
import { ensureMetaLearningResearchRegistry } from './metaLearningResearchTrack'
import { runNeuralMetaShadow } from './metaLearningShadowRunner'
import { hydrateMatureMetaShadowDecisionRewards } from './metaLearningShadowDecisions'
import { listLinUcbRewardSourceRowsAcrossDomains } from './metaLearningRewardLedger'
import { clearOpenPositionIntradayPriceCache } from './paperIntradayPriceCache'
import { classifySchedulerSummary, logSchedulerResult, type SchedulerRunStatus } from './schedulerRunLogger'
import { recordWorkerTaskComputeProfile } from './computeProfileEvents'
import { runAllocatorEvFeatureSnapshotBackfill } from './controllerResearchWorkflows'
import {
  evidenceOnlySnapshotNotApplicable,
  inspectActive8ActionAuthorityState,
  inspectAllocatorSnapshotClosure,
  readAllocatorEvLifecycle,
  recordAllocatorEvLifecycle,
} from './allocatorEvDailyLifecycle'
import {
  claimPipelineStage,
  enqueuePipelineStageAuthorized,
  markPipelineStageFenced,
  setPipelineStageCursorFenced,
} from './pipelineStageLease'
import {
  materializePriceHorizonLabels,
  materializeStrategyMultiHorizonPriceLabels,
} from './priceHorizonProjection'
import { materializeStrategyMultiHorizonOutcomes } from './strategyMultiHorizonOutcomes'
import { materializeStrategyEvidenceMetrics } from './strategyEvidenceMetrics'
import { refreshStrategyEvidenceOwnerCalibration } from './strategyEvidenceOwnerCalibration'
import { resolveEveningChainRunAuthority } from './eveningChainRunAuthority'

export type ChainContext = {
  runDate?: string
  upstreamRunId?: string
  stageLeaseOwner?: string
  recoveryAttempt?: number
  runScope?: 'live_canonical' | 'historical_replay' | 'derived'
  assertStageLease?: (boundary?: string) => Promise<void>
}

async function assertChainStageAuthority(ctx: ChainContext, boundary: string): Promise<void> {
  if (ctx.assertStageLease) await ctx.assertStageLease(boundary)
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
  await assertChainStageAuthority(ctx, `${task}:observability`)
  const results = await Promise.allSettled([
    withObservabilityTimeout(`${task} scheduler log`, logSchedulerResult(env.KV, task, {
      status,
      summary,
      duration_ms: durationMs,
      error,
      run_id: ctx.upstreamRunId,
      attempt_id: resolveChainAttemptId(ctx),
      run_date: ctx.runDate,
      run_scope: ctx.runScope,
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

export async function logChainedTask(
  env: Bindings,
  ctx: ChainContext,
  task: string,
  fn: () => Promise<unknown>,
  options: { critical?: boolean; timeoutMs?: number } = {},
): Promise<ChainedTask> {
  const t0 = Date.now()
  const critical = options.critical !== false
  try {
    await assertChainStageAuthority(ctx, `${task}:before_task`)
    const rawSummary = options.timeoutMs
      ? await withTaskExecutionTimeout(task, fn(), options.timeoutMs)
      : await fn()
    await assertChainStageAuthority(ctx, `${task}:after_task`)
    const summary = normalizeSummary(rawSummary)
    const status = classifySchedulerSummary(summary)
    const durationMs = Date.now() - t0
    await emitChainedTaskObservability(env, ctx, task, status, summary, durationMs)
    return { task, summary, status, critical }
  } catch (e: any) {
    await assertChainStageAuthority(ctx, `${task}:error_observability`)
    const summary = e?.message ?? `${task} failed`
    const durationMs = Date.now() - t0
    await emitChainedTaskObservability(env, ctx, task, 'error', summary, durationMs, String(e))
    return { task, summary, status: 'error', critical }
  }
}

async function logSkippedHistoricalTask(env: Bindings, ctx: ChainContext, task: string): Promise<ChainedTask> {
  await assertChainStageAuthority(ctx, `${task}:before_skipped_log`)
  const summary = `skipped non-production-authoritative callback run_date=${ctx.runDate ?? 'unknown'}; ${task} is live-canonical only`
  await logSchedulerResult(env.KV, task, {
    status: 'skipped',
    summary,
    duration_ms: 0,
    run_id: ctx.upstreamRunId,
    attempt_id: resolveChainAttemptId(ctx),
    run_date: ctx.runDate,
    run_scope: ctx.runScope,
  }, env)
  return { task, summary, status: 'skipped' }
}

export async function runMetaLearningShadowClosure(env: Bindings, ctx: ChainContext): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const registry = await ensureMetaLearningResearchRegistry(env.KV)
  const hydration = await hydrateMatureMetaShadowDecisionRewards(databaseForDataDomain(env, 'learning'), {
    endDate: runDate,
    limit: 50000,
  })
  const predictionDb = databaseForDataDomain(env, 'learning')
  const recommendationDb = databaseForDataDomain(env, 'core')
  const sourceRows = await listLinUcbRewardSourceRowsAcrossDomains(predictionDb, recommendationDb, {
    endDate: runDate,
    limit: 5000,
  })
  const decisionRows = await listLinUcbRewardSourceRowsAcrossDomains(predictionDb, recommendationDb, {
    startDate: runDate,
    endDate: runDate,
    limit: 5000,
    requireOutcome: false,
  })
  if (decisionRows.length === 0) {
    return [
      `reward_hydrated=${hydration.hydrated_decisions}`,
      'decision_contexts=0',
      `registry_created=${registry.created.length}`,
      `registry_total=${registry.total}`,
      'neural_ucb=not_run_no_current_decision_context',
      'neural_ts=not_run_no_current_decision_context',
      'neucb=not_run_no_current_decision_context',
    ].join(' ')
  }

  const [neuralUcb, neuralTs, neuCb] = await Promise.all([
    runNeuralMetaShadow(env, {
      policyId: 'NeuralUCB',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: META_SHADOW_POLICY_TIMEOUT_MS,
      sourceRows,
      decisionRows,
    }),
    runNeuralMetaShadow(env, {
      policyId: 'NeuralTS',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: META_SHADOW_POLICY_TIMEOUT_MS,
      sourceRows,
      decisionRows,
    }),
    runNeuralMetaShadow(env, {
      policyId: 'NeuCB',
      endDate: ctx.runDate,
      dryRun: false,
      timeoutMs: META_SHADOW_POLICY_TIMEOUT_MS,
      sourceRows,
      decisionRows,
    }),
  ])
  return [
    `reward_hydrated=${hydration.hydrated_decisions}`,
    `decision_contexts=${decisionRows.length}`,
    `registry_created=${registry.created.length}`,
    `registry_total=${registry.total}`,
    `neural_ucb=${normalizeSummary(neuralUcb)}`,
    `neural_ts=${normalizeSummary(neuralTs)}`,
    `neucb=${normalizeSummary(neuCb)}`,
  ].join(' ')
}

async function enqueueMetaLearningShadowClosureTask(
  env: Bindings,
  ctx: ChainContext,
  productionEligible: boolean,
): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const runId = ctx.upstreamRunId || `meta-learning-shadow-${runDate}-${Date.now()}`
  await assertChainStageAuthority(ctx, 'meta-learning-shadow:before_queue')
  await env.UPDATE_QUEUE.send({
    type: 'meta_learning_shadow_closure',
    cursor: 0,
    triggerTime: runDate,
    runId,
    force: productionEligible,
  })
  return `triggered meta-learning-shadow queue run_date=${runDate} run_id=${runId}`
}

async function enqueueStrategyLearningClosureTask(
  env: Bindings,
  ctx: ChainContext,
  productionEligible: boolean,
): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const runId = ctx.upstreamRunId || `strategy-learning-${runDate}-${Date.now()}`
  await assertChainStageAuthority(ctx, 'strategy-learning:before_queue')
  await env.UPDATE_QUEUE.send({
    type: 'strategy_learning_materialize',
    cursor: 0,
    cursorKey: '',
    triggerTime: runDate,
    runId,
    force: productionEligible,
  })
  return `triggered strategy-learning queue run_date=${runDate} run_id=${runId}`
}

async function enqueueS12ReplayBackfillTask(env: Bindings, ctx: ChainContext): Promise<string> {
  const runDate = ctx.runDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const canonicalRunId = String(ctx.upstreamRunId ?? '').trim()
  const leaseOwner = String(ctx.stageLeaseOwner ?? '').trim()
  if (!canonicalRunId || !leaseOwner) throw new Error('post_verify_stage_authority_missing')
  const { loadReplayReadySignalDates } = await import('./s12ReplayTradeOutcome')
  const signalDates = await loadReplayReadySignalDates(env.DB, runDate, 5)
  for (const signalDate of signalDates) {
    const lifecycle = await readAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), signalDate)
    const lifecycleRunId = String(lifecycle?.upstream_run_id ?? '').trim()
    if (!lifecycleRunId) {
      throw new Error(`s12_replay_lifecycle_generation_missing:${signalDate}`)
    }
    const runId = `${canonicalRunId}-s12-${signalDate}-${Date.now()}`
    const recorded = await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
      businessDate: signalDate,
      state: 'replay_enqueued',
      replayMaturityAsOfDate: runDate,
      upstreamRunId: lifecycleRunId,
      expectedLifecycleRunId: lifecycleRunId,
      stageAuthority: {
        businessDate: runDate,
        stage: 'post_verify_chain',
        canonicalRunId,
        leaseOwner,
      },
    }, databaseForDataDomain(env, 'ops'))
    if (!recorded) throw new Error(`stale_s12_replay_enqueue:${signalDate}:${canonicalRunId}`)
    await assertChainStageAuthority(ctx, `s12-replay:${signalDate}:before_queue`)
    await env.UPDATE_QUEUE.send({
      type: 's12_replay_backfill_chunk',
      cursor: 0,
      triggerTime: signalDate,
      runId,
      replayScope: 'fusion_snapshot_missing',
      maturityAsOfDate: runDate,
      statusRunDate: runDate,
      lifecycleRunId,
    } as any)
  }
  const currentRecorded = await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
    businessDate: runDate,
    state: 'replay_pending_maturity',
    upstreamRunId: canonicalRunId,
    stageAuthority: {
      businessDate: runDate,
      stage: 'post_verify_chain',
      canonicalRunId,
      leaseOwner,
    },
  }, databaseForDataDomain(env, 'ops'))
  if (!currentRecorded) throw new Error(`stale_post_verify_lifecycle:${runDate}:${canonicalRunId}`)
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
  await assertChainStageAuthority(ctx, `${task}:before_summary`)
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
    run_scope: ctx.runScope,
  }, env)
}

async function recordPostPipelineLifecycle(
  env: Bindings,
  ctx: ChainContext,
  input: Parameters<typeof recordAllocatorEvLifecycle>[1],
): Promise<void> {
  await assertChainStageAuthority(ctx, `allocator-lifecycle:${input.state}:before_write`)
  const canonicalRunId = String(ctx.upstreamRunId ?? '').trim()
  const leaseOwner = String(ctx.stageLeaseOwner ?? '').trim()
  if (!canonicalRunId || !leaseOwner) {
    throw new Error('post_pipeline_stage_authority_missing')
  }
  const recorded = await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
    ...input,
    upstreamRunId: canonicalRunId,
    stageAuthority: {
      stage: 'post_pipeline_chain',
      canonicalRunId,
      leaseOwner,
    },
  }, databaseForDataDomain(env, 'ops'))
  await assertChainStageAuthority(ctx, `allocator-lifecycle:${input.state}:after_write`)
  if (!recorded) {
    throw new Error(`post_pipeline_stage_authority_lost:${input.businessDate}:${canonicalRunId}`)
  }
}

export async function runPostPipelineCallbackChain(
  env: Bindings,
  ctx: ChainContext,
): Promise<'waiting' | 'success' | 'error'> {
  const startedAt = Date.now()
  const results: ChainedTask[] = []

  await assertChainStageAuthority(ctx, 'post-pipeline:entry')
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
  await assertChainStageAuthority(ctx, 'post-pipeline:before_snapshot_inspection')
  let snapshotClosure = await inspectAllocatorSnapshotClosure(env.DB, ctx.runDate, {
    // This stage owns the explicit PIT backfill. Reconstruction may close the
    // operational evidence chain, while Fusion promotion remains native-only.
    learningDb: databaseForDataDomain(env, 'learning'),
    opsDb: databaseForDataDomain(env, 'ops'),
    coreDb: databaseForDataDomain(env, 'core'),
    allowPointInTimeReconstruction: true,
    kv: env.KV,
  })
  await assertChainStageAuthority(ctx, 'post-pipeline:after_snapshot_inspection')
  const actionAuthority = await inspectActive8ActionAuthorityState(
    databaseForDataDomain(env, 'learning'),
    databaseForDataDomain(env, 'core'),
    ctx.runDate,
  )
  if (actionAuthority.pointerRows !== actionAuthority.validServingRows) {
    throw new Error(
      `active8_serving_pointer_integrity_invalid:pointer=${actionAuthority.pointerRows}:valid=${actionAuthority.validServingRows}`,
    )
  }
  const snapshotUnavailableInEvidenceOnlyMode = evidenceOnlySnapshotNotApplicable(
    snapshotClosure,
    actionAuthority,
  )
  if (actionAuthority.pointerRows === 0 && actionAuthority.actionableRows > 0) {
    throw new Error(`active8_evidence_only_action_leak:rows=${actionAuthority.actionableRows}`)
  }
  results.push({
    task: 'active8-action-authority',
    summary: `pointer=${actionAuthority.pointerRows} valid=${actionAuthority.validServingRows} recommendations=${actionAuthority.recommendationRows} actionable=${actionAuthority.actionableRows} production_effect=${actionAuthority.pointerRows === 1 ? 1 : 0}`,
    status: 'success',
    critical: true,
  })
  await recordPostPipelineLifecycle(env, ctx, {
    businessDate: ctx.runDate,
    state: 'lineage_ready',
    nativeLineageRows: snapshotClosure.nativeLineageRows,
    upstreamRunId: ctx.upstreamRunId,
    incrementAttempt: true,
  })
  const snapshotAttempt = Math.max(0, Number(ctx.recoveryAttempt ?? 0))
  if (!snapshotClosure.ready && !snapshotUnavailableInEvidenceOnlyMode && snapshotAttempt >= 3) {
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
    await recordPostPipelineLifecycle(env, ctx, {
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
  let snapshotTask: ChainedTask
  if (snapshotUnavailableInEvidenceOnlyMode) {
    const summary = `not applicable: Active8 evidence-only authority attested date=${ctx.runDate} recommendations=${actionAuthority.recommendationRows} actionable=0 production_effect=0`
    await emitChainedTaskObservability(
      env,
      ctx,
      'allocator-ev-feature-snapshot-backfill',
      'skipped',
      summary,
      0,
    )
    snapshotTask = {
      task: 'allocator-ev-feature-snapshot-backfill',
      summary,
      status: 'skipped',
      critical: false,
    }
  } else {
    snapshotTask = await logChainedTask(
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
  }
  results.push(snapshotTask)
  const snapshotPending = snapshotTask.status !== 'error'
    && /\bstatus=(?:spawned|pending)\b/i.test(snapshotTask.summary)
  if (snapshotPending) {
    await recordPostPipelineLifecycle(env, ctx, {
      businessDate: ctx.runDate,
      state: 'lineage_ready',
      nativeLineageRows: snapshotClosure.nativeLineageRows,
      upstreamRunId: ctx.upstreamRunId,
    })
    await logChainSummary(env, ctx, 'post-pipeline-chain', startedAt, results)
    return 'waiting'
  }
  if (!snapshotUnavailableInEvidenceOnlyMode) {
    await assertChainStageAuthority(ctx, 'post-pipeline:before_snapshot_readback')
    snapshotClosure = await inspectAllocatorSnapshotClosure(env.DB, ctx.runDate, {
      allowPointInTimeReconstruction: true,
      learningDb: databaseForDataDomain(env, 'learning'),
      opsDb: databaseForDataDomain(env, 'ops'),
      coreDb: databaseForDataDomain(env, 'core'),
      kv: env.KV,
    })
    await assertChainStageAuthority(ctx, 'post-pipeline:after_snapshot_readback')
  }
  if (snapshotTask.status === 'error' || (!snapshotUnavailableInEvidenceOnlyMode && !snapshotClosure.ready)) {
    const error = snapshotTask.status === 'error'
      ? snapshotTask.summary
      : `snapshot readback incomplete native=${snapshotClosure.runNativeLineageRows} `
        + `reconstructed=${snapshotClosure.reconstructedLineageRows} rejected=${snapshotClosure.rejectedLineageRows} `
        + `expected=${snapshotClosure.expectedRows} published=${snapshotClosure.publishedRows} actual=${snapshotClosure.actualRows}`
    await recordPostPipelineLifecycle(env, ctx, {
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
      await assertChainStageAuthority(ctx, 'allocator-snapshot-recovery:before_queue')
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
  if (!snapshotUnavailableInEvidenceOnlyMode) {
    await recordPostPipelineLifecycle(env, ctx, {
      businessDate: ctx.runDate,
      state: 'snapshot_ready',
      nativeLineageRows: snapshotClosure.nativeLineageRows,
      snapshotRunId: snapshotClosure.snapshotRunId,
      snapshotRows: snapshotClosure.actualRows,
      upstreamRunId: ctx.upstreamRunId,
    })
  }
  const snapshotEvidenceKey = snapshotUnavailableInEvidenceOnlyMode
    ? 'active8-evidence-only-authority-v1'
    : String(snapshotClosure.snapshotRunId ?? '')
  const pipelineRunId = String(ctx.upstreamRunId ?? '').trim()
  const pipelineLeaseOwner = String(ctx.stageLeaseOwner ?? '').trim()
  await assertChainStageAuthority(ctx, 'verify-v2:before_stage_enqueue')
  const verifyStage = await enqueuePipelineStageAuthorized(databaseForDataDomain(env, 'ops'), {
    businessDate: ctx.runDate,
    stage: 'verify_v2',
    runId: pipelineRunId,
    authority: {
      stage: 'post_pipeline_chain',
      canonicalRunId: pipelineRunId,
      status: 'running',
      leaseOwner: pipelineLeaseOwner,
    },
  })
  if (verifyStage.row.canonical_run_id !== pipelineRunId) {
    throw new Error(
      `verify_stage_owner_conflict:incoming=${pipelineRunId}:canonical=${verifyStage.row.canonical_run_id}`,
    )
  }
  let verifyTask: ChainedTask
  if (!verifyStage.shouldEnqueue) {
    verifyTask = {
      task: 'verify-v2',
      status: verifyStage.row.status === 'success' ? 'success' : 'triggered',
      critical: true,
      summary: `verify stage already status=${verifyStage.row.status} run_id=${verifyStage.row.canonical_run_id}`,
    }
  } else {
    const verifyLeaseOwner = `${pipelineRunId}:verify:${crypto.randomUUID()}`
    const claimed = await claimPipelineStage(databaseForDataDomain(env, 'ops'), {
      businessDate: ctx.runDate,
      stage: 'verify_v2',
      ownerId: verifyLeaseOwner,
      canonicalRunId: pipelineRunId,
      leaseSeconds: 120,
    })
    if (!claimed) {
      verifyTask = {
        task: 'verify-v2',
        status: 'triggered',
        critical: true,
        summary: 'verify stage was claimed by another worker',
      }
    } else {
      const verifyIdempotencyKey = `verify_v2:${ctx.runDate}:${snapshotEvidenceKey}`
      const expectedProducerRunId = await expectedVerifyProducerRunId(ctx.runDate, verifyIdempotencyKey)
      const cursorStored = await setPipelineStageCursorFenced(databaseForDataDomain(env, 'ops'), {
        businessDate: ctx.runDate,
        stage: 'verify_v2',
        canonicalRunId: pipelineRunId,
        leaseOwner: verifyLeaseOwner,
        cursorKey: expectedProducerRunId,
      })
      if (!cursorStored) throw new Error('verify_stage_cursor_fence_lost')
      verifyTask = await logChainedTask(
        env,
        ctx,
        'verify-v2',
        () => runVerifyV2(env, ctx.runDate, verifyIdempotencyKey),
      )
      const finalized = await markPipelineStageFenced(databaseForDataDomain(env, 'ops'), {
        businessDate: ctx.runDate,
        stage: 'verify_v2',
        canonicalRunId: pipelineRunId,
        cursorKey: expectedProducerRunId,
        leaseOwner: verifyLeaseOwner,
        status: verifyTask.status === 'error' ? 'error' : 'waiting',
        error: verifyTask.status === 'error' ? verifyTask.summary : null,
      })
      if (!finalized) {
        const callbackWonRace = await databaseForDataDomain(env, 'ops').prepare(`
          SELECT 1 AS ok FROM pipeline_stage_runs
           WHERE business_date=? AND stage='verify_v2'
             AND canonical_run_id=? AND cursor_key=? AND status='success'
        `).bind(ctx.runDate, pipelineRunId, expectedProducerRunId).first<{ ok: number }>()
        if (!callbackWonRace) throw new Error('verify_stage_finalize_fence_lost')
      }
    }
  }
  results.push(verifyTask)
  if (verifyTask.status !== 'error') {
    await recordPostPipelineLifecycle(env, ctx, {
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
  await assertChainStageAuthority(ctx, 'post-verify:entry')
  const productionAuthority = await resolveEveningChainRunAuthority(env, {
    businessDate: String(ctx.runDate ?? ''),
    canonicalRunId: String(ctx.upstreamRunId ?? ''),
  })
  const productionEligible = productionAuthority.allowed
  ctx = { ...ctx, runScope: productionAuthority.runScope }

  const projectionTask = await logChainedTask(env, ctx, 'price-horizon-projection', async () => {
    const outcomeAsOfDate = twDateToday()
    const stageMs: Record<string, number> = {}
    let stageStartedAt = Date.now()
    const canonical = await materializePriceHorizonLabels(env, {
      endDate: ctx.runDate,
      outcomeAsOfDate,
      maxSignalDates: 60,
      maxProcessDates: 8,
    })
    stageMs.canonical_labels = Date.now() - stageStartedAt
    stageStartedAt = Date.now()
    const multiHorizon = await materializeStrategyMultiHorizonPriceLabels(env, {
      endDate: ctx.runDate,
      outcomeAsOfDate,
      maxSignalDates: 60,
      maxProcessDates: 3,
    })
    stageMs.multi_horizon_labels = Date.now() - stageStartedAt
    stageStartedAt = Date.now()
    const outcomes = await materializeStrategyMultiHorizonOutcomes(env, {
      asOfDate: outcomeAsOfDate,
      endDate: ctx.runDate,
    })
    stageMs.multi_horizon_outcomes = Date.now() - stageStartedAt
    stageStartedAt = Date.now()
    const metrics = await materializeStrategyEvidenceMetrics(env, { outcomeAsOfDate })
    stageMs.strategy_evidence_metrics = Date.now() - stageStartedAt
    stageStartedAt = Date.now()
    const calibration = await refreshStrategyEvidenceOwnerCalibration(env, {
      knowledgeCutoffDate: ctx.runDate!,
      allowPromotion: productionEligible,
    })
    stageMs.strategy_evidence_owner_calibration = Date.now() - stageStartedAt
    return `${canonical.summary} | ${multiHorizon.summary} | ${outcomes.summary} | ${metrics.summary} | strategy_evidence_owner_calibration=${calibration.result.status}:${calibration.runId} | stage_ms=${JSON.stringify(stageMs)}`
  }, { timeoutMs: 360_000 })
  results.push(projectionTask)
  if (projectionTask.status === 'error') {
    await logChainSummary(env, ctx, 'post-verify-chain', startedAt, results)
    return 'error'
  }

  results.push(await logChainedTask(env, ctx, 'model-ic-rolling', () => runModelIcRollingRefresh(env, ctx.runDate)))
  if (productionEligible) {
    results.push(await logChainedTask(env, ctx, 'artifact-auto-promotion', () => runArtifactAutoPromotion(env), { critical: false }))
  } else {
    results.push(await logSkippedHistoricalTask(env, ctx, 'artifact-auto-promotion'))
  }
  results.push(await logChainedTask(env, ctx, 's12-replay-backfill', () => enqueueS12ReplayBackfillTask(env, ctx), {
    timeoutMs: TASK_EXECUTION_TIMEOUT_MS,
  }))

  if (productionEligible) {
    results.push(await logChainedTask(env, ctx, 'paper-intraday-cache-clear', () => clearOpenPositionIntradayPriceCache(env), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh(env, ctx.runDate)))
    results.push(await logChainedTask(env, ctx, 'adapt', () => runAdaptiveUpdate(env, { refreshLedger: false })))
    results.push(await logChainedTask(env, ctx, 'daily-report', () => generateDailyReport(env)))
    results.push(await logChainedTask(env, ctx, 'paper-active-postmarket', () => runPaperActivePostmarketPromotion(env, ctx.runDate), { critical: false }))
    results.push(await logChainedTask(env, ctx, 'obsidian-sync', () => runObsidianDaily(env, ctx.runDate!), {
      critical: false,
      timeoutMs: TASK_EXECUTION_TIMEOUT_MS,
    }))
    results.push(await logChainedTask(env, ctx, 'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask(env, ctx, productionEligible), {
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
  results.push(await logChainedTask(env, ctx, 'strategy-learning', () => enqueueStrategyLearningClosureTask(env, ctx, productionEligible), {
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
