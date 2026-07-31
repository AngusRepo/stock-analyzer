import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'
import { databaseForDataDomain } from './dataDomainRegistry'
import { runVerifyV2 } from './controllerWorkflows'
import { twToday } from './dateUtils'
import { runMorningWarmup, runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'
import type { LegacyHotDataTarget } from './legacyHotDataRetirement'
import { runWithMaintenanceLease, summarizeMaintenanceLeaseResult } from './maintenanceLease'
import {
  resolveEveningChainClosureDurationMs,
  resolveEveningChainRunAuthority,
} from './eveningChainRunAuthority'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'

const RESCORE_SLOT_TASK_BY_CRON: Record<string, string> = {
  '0 2 * * 1-5': 'rescore-10',
  '0 3 * * 1-5': 'rescore-11',
  '0 4 * * 1-5': 'rescore-12',
  '30 4 * * 1-5': 'rescore-1230',
}
const RESCORE_CRONS = new Set(Object.keys(RESCORE_SLOT_TASK_BY_CRON))
const D1_HEAVY_MAINTENANCE_TASKS = new Set([
  'debate-memory-retention', 'audit-json-retention', 'artifact-reconcile',
  'legacy-evidence-migration', 'legacy-strategy-evidence-migration',
  'legacy-hot-data-retirement', 'd1-evidence-scrub', 'r2-retention-sweep',
  'orphan-reachability-gc', 'cleanup-dlq-replay', 'weekly-cleanup',
  'price-horizon-projection',
  'strategy-learning-finalize',
  'selection-reference-repair', 'selection-reference-identity-repair',
  'data-domain-shadow-backfill',
])
const D1_MAINTENANCE_REQUEST_BUDGET_MS = 45_000

type WarmupSummary = {
  ok: boolean
  summary: string
}

function inferIntradayRescoreCron(rawCron?: string | null): string {
  if (rawCron && RESCORE_CRONS.has(rawCron)) return rawCron
  const now = new Date()
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()
  if (hour === 2) return '0 2 * * 1-5'
  if (hour === 3) return '0 3 * * 1-5'
  if (hour === 4 && minute >= 25) return '30 4 * * 1-5'
  if (hour === 4) return '0 4 * * 1-5'
  return 'manual'
}

function warmupTargetStatus(name: string, value: unknown): string {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const status = typeof record.status === 'string' && record.status.trim()
    ? record.status.trim()
    : 'unknown'
  const details: string[] = []
  if (name === 'strategy_similarity_evidence') {
    const pam = typeof record.kmedoids_pam_preflight_status === 'string' && record.kmedoids_pam_preflight_status.trim()
      ? record.kmedoids_pam_preflight_status.trim()
      : ''
    const owner = typeof record.algorithm_owner === 'string' && record.algorithm_owner.trim()
      ? record.algorithm_owner.trim()
      : ''
    if (pam) details.push(`pam=${pam}`)
    if (owner) details.push(`owner=${owner}`)
  }
  return `${name}=${status}${details.length ? `(${details.join(',')})` : ''}`
}

export function summarizeMlControllerWarmupTargets(body: unknown): WarmupSummary {
  const targets = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).targets
    : null
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    return { ok: false, summary: 'targets=unknown' }
  }

  const entries = Object.entries(targets)
  if (!entries.length) return { ok: false, summary: 'targets=empty' }

  const summary = entries.map(([name, value]) => warmupTargetStatus(name, value)).join(' ')
  const ok = entries.every(([, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    return (value as Record<string, unknown>).status === 'ok'
  })
  return { ok, summary }
}

async function runMlControllerWarmup(env: any): Promise<string> {
  if (!env.ML_CONTROLLER_URL) return 'SKIP: ML_CONTROLLER_URL not set'
  const headers: Record<string, string> = {}
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
  const warmup = await fetch(`${env.ML_CONTROLLER_URL}/warmup`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null)
  if (warmup?.ok) {
    const body = await warmup.json().catch(() => ({})) as any
    const targets = summarizeMlControllerWarmupTargets(body)
    return `ML Controller warmup ${targets.ok ? 'ok' : 'degraded'} ${targets.summary}`
  }

  const res = await fetch(`${env.ML_CONTROLLER_URL}/health`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)
  if (!res?.ok) return `ML Controller warmup failed${warmup ? ` (${warmup.status})` : ''}; health failed${res ? ` (${res.status})` : ''}`
  const health = await res.json().catch(() => ({})) as any
  return [
    `ML Controller warmup degraded${warmup ? ` (${warmup.status})` : ''}; health ok`,
    `pipelineJob=${health.pipelineJobConfigured ? 'ok' : 'missing'}`,
    `verifyJob=${health.verifyJobConfigured ? 'ok' : 'missing'}`,
    `callback=${health.callbackConfigured ? 'ok' : 'missing'}`,
  ].join(' ')
}

function parseBoundedPositiveInt(raw: string | null | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

async function runNeuralShadowTask(
  c: any,
  policyId: 'NeuralUCB' | 'NeuralTS' | 'NeuCB',
  endDate?: string,
): Promise<string> {
  const persist = c.req.query('persist') === '1' || c.req.query('dry_run') === 'false'
  if (persist && c.req.header('X-Confirm-Meta-Learning') !== 'true') {
    throw new Error(`${policyId} shadow persistence requires X-Confirm-Meta-Learning:true`)
  }

  const { runNeuralMetaShadow } = await import('./metaLearningShadowRunner')
  const result = await runNeuralMetaShadow(c.env, {
    policyId,
    startDate: c.req.query('start_date') || undefined,
    endDate,
    limit: parseBoundedPositiveInt(c.req.query('limit'), 5000, 20000),
    dryRun: !persist,
  })

  const summary = [
    `policy=${policyId}`,
    `mode=${result.mode}`,
    `success=${result.success}`,
    `source_rows=${(result as any).source_rows ?? 0}`,
    `training_samples=${(result as any).training_samples ?? 0}`,
    `persisted_rows=${(result as any).persisted_rows ?? 0}`,
  ]
  if ((result as any).reason) summary.push(`reason=${(result as any).reason}`)
  return summary.join(' ')
}

async function runAdaptiveMetaPolicyReplayTask(c: any, endDate?: string): Promise<string> {
  const persist = c.req.query('persist') === '1' || c.req.query('dry_run') === 'false'
  if (persist && c.req.header('X-Confirm-Meta-Learning') !== 'true') {
    throw new Error('adaptive meta-policy replay evidence persistence requires X-Confirm-Meta-Learning:true')
  }

  const { runAdaptiveMetaPolicyReplay } = await import('./adaptiveMetaPolicyReplayRunner')
  const result = await runAdaptiveMetaPolicyReplay(c.env, {
    startDate: c.req.query('start_date') || undefined,
    endDate,
    limit: parseBoundedPositiveInt(c.req.query('limit'), 20000, 50000),
    minIcSamples: parseBoundedPositiveInt(c.req.query('min_ic_samples'), 5, 200),
    minWindows: parseBoundedPositiveInt(c.req.query('min_windows'), 8, 260),
    neuralEpochs: parseBoundedPositiveInt(c.req.query('neural_epochs'), 80, 1000),
    persist,
  })
  return String(result.summary ?? `adaptive_meta_replay status=${result.status ?? 'unknown'}`)
}

async function runLinUcbMultiplierReplayTask(c: any, endDate?: string): Promise<string> {
  const persist = c.req.query('persist') === '1' || c.req.query('dry_run') === 'false'
  if (persist && c.req.header('X-Confirm-Meta-Learning') !== 'true') {
    throw new Error('LinUCB multiplier replay evidence persistence requires X-Confirm-Meta-Learning:true')
  }

  const {
    LINUCB_MULTIPLIER_REPLAY_DEFAULT_LIMIT,
    LINUCB_MULTIPLIER_REPLAY_DEFAULT_MAX_GRID_EVALS,
    runLinUcbMultiplierReplay,
  } = await import('./linucbMultiplierReplayRunner')
  const result = await runLinUcbMultiplierReplay(c.env, {
    startDate: c.req.query('start_date') || undefined,
    endDate,
    limit: parseBoundedPositiveInt(c.req.query('limit'), LINUCB_MULTIPLIER_REPLAY_DEFAULT_LIMIT, 50000),
    minDecisions: parseBoundedPositiveInt(c.req.query('min_decisions'), 30, 10000),
    maxGridEvals: parseBoundedPositiveInt(c.req.query('max_grid_evals'), LINUCB_MULTIPLIER_REPLAY_DEFAULT_MAX_GRID_EVALS, 500),
    recentLossWindow: parseBoundedPositiveInt(c.req.query('recent_loss_window'), 5, 60),
    persist,
  })
  return String(result.summary ?? `linucb_multiplier_replay status=${result.status ?? 'unknown'}`)
}

function assertRunDate(value?: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('post-screener-pipeline requires date=YYYY-MM-DD')
  }
  return value
}

async function enqueuePostScreenerPipelineContinuation(c: any, runDate?: string): Promise<string> {
  const triggerTime = assertRunDate(runDate)
  const screener = await c.env.DB.prepare(`
    SELECT sfr.run_id, sfr.final_count, sfr.emerging_count
      FROM screener_funnel_runs sfr
     WHERE sfr.run_id = COALESCE(
       (
         SELECT h.run_id
           FROM canonical_run_heads h
           JOIN pipeline_runs p ON p.run_id = h.run_id AND p.status = 'canonical'
          WHERE h.logical_run_key = ?
          LIMIT 1
       ),
       (
         SELECT run_id
           FROM screener_funnel_runs
          WHERE date = ? AND status = 'success'
          ORDER BY created_at DESC
          LIMIT 1
       )
     )
     LIMIT 1
  `).bind(`screener:${triggerTime}:TW:production:market_screener`, triggerTime).first() as { run_id?: string; final_count?: number; emerging_count?: number } | null

  if (!screener?.run_id) {
    throw new Error(`No successful screener_funnel_run found for ${triggerTime}; refusing post-screener pipeline continuation`)
  }

  const runId = `manual-post-screener-${triggerTime}-${Date.now().toString(36)}`
  await c.env.UPDATE_QUEUE.send({
    type: 'post_screener_pipeline',
    cursor: 0,
    triggerTime,
    runId,
    shardCount: 1,
    attempt: 1,
  })

  return [
    `triggered post-screener pipeline continuation for ${triggerTime}`,
    `run_id=${runId}`,
    `screener_run_id=${screener.run_id}`,
    `final=${Number(screener.final_count ?? 0)}`,
    `emerging=${Number(screener.emerging_count ?? 0)}`,
    'callback expected',
  ].join('; ')
}

async function enqueueStrategyLearningMaterialization(c: any, runDate?: string): Promise<string> {
  const triggerTime = assertRunDate(runDate)
  const runId = `manual-strategy-learning-${triggerTime}-${Date.now().toString(36)}`
  await c.env.UPDATE_QUEUE.send({
    type: 'strategy_learning_materialize',
    cursor: 0,
    triggerTime,
    runId,
    force: c.req.query('force_policy') === '1',
  })

  return [
    `triggered strategy-learning materialization for ${triggerTime}`,
    `run_id=${runId}`,
    'callback expected',
  ].join('; ')
}

export function buildAdminWorkerDomainTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  const requestedRunDate = () => c.req.query('date') || undefined

  const tasks: Record<string, TaskHandler> = {
    'market-close-refresh': () => deps.runMarketCloseRefresh(!!c.req.query('force'), requestedRunDate()),
    'evening-chain': () => deps.runDailyUpdate(!!c.req.query('force'), requestedRunDate()),
    screener: () => deps.runMarketScreener(requestedRunDate()),
    'screener-v2': () => {
      if (!deps.runScreenerV2) throw new Error('screener-v2 trigger dependency not configured')
      return deps.runScreenerV2(requestedRunDate())
    },
    update: () => deps.runDailyUpdate(!!c.req.query('force'), requestedRunDate()),
    ml: () => deps.runMLAndRiskV2(requestedRunDate()),
    recommendation: () => deps.runDailyRecommendation(requestedRunDate()),
    'post-screener-pipeline': () => enqueuePostScreenerPipelineContinuation(c, requestedRunDate()),
    'strategy-learning': () => enqueueStrategyLearningMaterialization(c, requestedRunDate()),
    'strategy-learning-finalize': async () => {
      const runDate = assertRunDate(requestedRunDate())
      const { finalizeStrategyLearningEvidenceV5 } = await import('./strategyLearning')
      const {
        completeStrategyLearningRun,
        deferStrategyLearningFinalizer,
        failStrategyLearningRun,
        loadStrategyLearningRun,
        markStrategyLearningRunFinalized,
      } = await import('./strategyLearningRunState')
      const { logSchedulerResult } = await import('./schedulerRunLogger')
      const runState = await loadStrategyLearningRun(c.env.DB, runDate)
      if (!runState) throw new Error(`strategy_learning_run_missing:${runDate}`)
      const finalizerAttemptId = `${runState.canonical_run_id}:manual-finalize:${Date.now().toString(36)}`
      let materializationValidated = false
      try {
        const coverage = await completeStrategyLearningRun(c.env.DB, {
          businessDate: runDate,
          runId: runState.canonical_run_id,
        })
        materializationValidated = true
        const productionAuthority = c.req.query('force_policy') === '1'
          ? await resolveEveningChainRunAuthority(c.env, {
              businessDate: runDate,
              canonicalRunId: runState.canonical_run_id,
            })
          : null
        const currentBusinessDateRun = productionAuthority?.allowed === true
        const runScope = productionAuthority?.runScope ?? 'historical_replay'
        const authorityReason = productionAuthority?.reason ?? 'force_policy_not_requested'
        const chainDurationMs = await resolveEveningChainClosureDurationMs(c.env.DB, runDate)
        const {
          auditEveningChainEvidenceClosure,
          resolveExpectedMatureSignalDate,
          summarizeEveningChainEvidenceClosure,
        } = await import('./eveningChainEvidenceClosure')
        const historicalPriorityDate = await resolveExpectedMatureSignalDate(c.env, runDate)
        const { recoverMatureSelectionEvidence } = await import('./matureSelectionEvidenceRecovery')
        const matureRecovery = await recoverMatureSelectionEvidence(c.env, runDate, {
          maxRecoveryDates: 4,
        })
        let closureSummary = ''
        const { decisionEvidence, historicalEvidence, labels, marginalEdge, routeBackfillEligibility, rewards, policy, thresholdCalibration }
          = await finalizeStrategyLearningEvidenceV5(c.env.DB, runDate, {
            allowPromotion: currentBusinessDateRun,
            persistPolicy: currentBusinessDateRun,
            calibrateThresholds: currentBusinessDateRun,
            calibrationCadence: 'daily_drift',
            historicalPriorityDate,
            beforePromotion: async () => {
              const closureAudit = await auditEveningChainEvidenceClosure(
                c.env,
                runDate,
                String(runState.producer_run_id ?? ''),
              )
              closureSummary = summarizeEveningChainEvidenceClosure(closureAudit)
            },
          })
        if (!closureSummary) throw new Error('evening_chain_evidence_closure_callback_missing')
        const summary = [
        `strategy_learning_finalize date=${runDate}`,
        `materialized_complete candidates=${coverage.candidateRows}/${coverage.expectedCandidates} rows=${coverage.decisionRows}/${coverage.expectedRows}`,
        `mature_recovery=${matureRecovery.summary}`,
        `selection_decisions=${decisionEvidence.finalSignalRows}/${decisionEvidence.referenceRows}`,
        `selection_ev_owner=${decisionEvidence.evOwnerRows}`,
        `strategy_pit_rebuild=${historicalEvidence.successfulDates}/${historicalEvidence.attemptedDates}`,
        `strategy_pit_blocked=${historicalEvidence.blockedDates}`,
        `strategy_pit_matrix_rows=${historicalEvidence.rebuiltMatrixRows}`,
        `selection_labels=${labels.persisted_rows}`,
        `selection_pending=${labels.pending_rows}`,
        `selection_unavailable=${labels.unavailable_rows}`,
        `strategy_edge=${marginalEdge.status}:eligible=${marginalEdge.eligibleStrategies}:dates=${marginalEdge.sampleDates}`,
        `route_backfill_eligible=${routeBackfillEligibility.filter((row) => row.status === 'eligible').length}`,
        `route_backfill_unavailable=${routeBackfillEligibility.filter((row) => row.status === 'unavailable').length}`,
        `route_backfill_pending=${routeBackfillEligibility.filter((row) => row.status === 'pending_maturity').length}`,
        `reward_source_rows=${rewards.source_rows}`,
        `reward_rows=${rewards.persisted_rows}`,
        `reward_stale_retired=${rewards.stale_rows_retired}`,
        `refresh_run_id=${rewards.refresh_run_id ?? 'none'}`,
        `policy=${policy ? policy.policy_state.status : 'skipped_historical'}`,
        `threshold_calibration=${thresholdCalibration ? thresholdCalibration.status : 'skipped_historical'}`,
        `evidence_closure=${closureSummary}`,
        `run_scope=${runScope}`,
        `production_authority=${authorityReason}`,
        ].join(' ')
        await logSchedulerResult(c.env.KV, 'strategy-learning', {
          status: 'success', summary, duration_ms: chainDurationMs, run_id: runState.canonical_run_id,
          attempt_id: finalizerAttemptId, run_date: runDate, run_scope: runScope,
        })
        await logSchedulerResult(c.env.KV, 'post-verify-chain', {
          status: 'success', summary: `strategy-learning finalizer recovered; ${summary}`,
          duration_ms: chainDurationMs, run_id: runState.canonical_run_id,
          attempt_id: finalizerAttemptId, run_date: runDate, run_scope: runScope,
        })
        await logSchedulerResult(c.env.KV, 'evening-chain', {
          status: 'success', summary: `root chain closed by strategy-learning finalizer; ${summary}`,
          duration_ms: chainDurationMs, run_id: runState.canonical_run_id,
          attempt_id: finalizerAttemptId, run_date: runDate, run_scope: runScope,
        })
        await markStrategyLearningRunFinalized(c.env.DB, {
          businessDate: runDate,
          runId: runState.canonical_run_id,
        })
        return summary
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (materializationValidated) {
          await deferStrategyLearningFinalizer(c.env.DB, {
            businessDate: runDate,
            runId: runState.canonical_run_id,
            error: errorMessage,
          })
        } else {
          await failStrategyLearningRun(c.env.DB, {
            businessDate: runDate,
            error: errorMessage,
          })
        }
        await Promise.allSettled([
          logSchedulerResult(c.env.KV, 'strategy-learning', {
            status: 'error', summary: errorMessage, error: errorMessage, duration_ms: 0,
            run_id: runState.canonical_run_id, attempt_id: finalizerAttemptId, run_date: runDate,
          }),
          logSchedulerResult(c.env.KV, 'post-verify-chain', {
            status: 'error', summary: `strategy-learning finalizer blocked: ${errorMessage}`,
            error: errorMessage, duration_ms: 0, run_id: runState.canonical_run_id,
            attempt_id: finalizerAttemptId, run_date: runDate,
          }),
          logSchedulerResult(c.env.KV, 'evening-chain', {
            status: 'error', summary: `root chain blocked by strategy-learning evidence audit: ${errorMessage}`,
            error: errorMessage, duration_ms: 0, run_id: runState.canonical_run_id,
            attempt_id: finalizerAttemptId, run_date: runDate,
          }),
        ])
        throw error
      }
    },
    'selection-reference-identity-repair': async () => {
      const endDate = assertRunDate(c.req.query('end_date') ?? requestedRunDate())
      const startDate = assertRunDate(c.req.query('start_date') ?? endDate)
      const { repairSelectionReferenceStockIdentities } = await import('./selectionReferenceRepair')
      const result = await repairSelectionReferenceStockIdentities(
        databaseForDataDomain(c.env, 'core'),
        databaseForDataDomain(c.env, 'learning'),
        { startDate, endDate, dryRun: c.req.query('dry_run') === '1' },
      )
      return [
        'selection_reference_identity_repair',
        `range=${result.start_date}..${result.end_date}`,
        `expected=${result.expected_rows}`,
        `missing_before=${result.missing_before}`,
        `repaired=${result.repaired_rows}`,
        `missing_after=${result.missing_after}`,
        `dry_run=${result.dry_run}`,
        `run_id=${result.run_id}`,
      ].join(' ')
    },
    'selection-reference-repair': async () => {
      const runDate = assertRunDate(requestedRunDate())
      const { repairHistoricalSelectionReferences } = await import('./selectionReferenceRepair')
      const result = await repairHistoricalSelectionReferences(c.env.DB, runDate, {
        dryRun: c.req.query('dry_run') === '1',
      })
      return [
        'selection_reference_repair date=' + result.signal_date,
        'run_id=' + result.producer_run_id,
        'expected=' + result.expected_rows,
        'persisted=' + result.persisted_rows,
        'strategy_matrix=' + result.strategy_matrix_status,
        'dry_run=' + result.dry_run,
        'artifact=' + result.source_artifact_id,
      ].join(' ')
    },
    'strategy-threshold-calibration': async () => {
      const { runStrategyThresholdAutoCalibration } = await import('./strategyLearning')
      const cadence = c.req.query('cadence') === 'monthly'
        ? 'monthly'
        : c.req.query('cadence') === 'daily_drift'
          ? 'daily_drift'
          : c.req.query('cadence') === 'regime_shift'
            ? 'regime_shift'
            : 'weekly'
      const result = await runStrategyThresholdAutoCalibration(c.env.DB, {
        runDate: requestedRunDate() ?? twToday(),
        cadence,
        startDate: c.req.query('start_date') || undefined,
        endDate: c.req.query('end_date') || undefined,
        dryRun: c.req.query('dry_run') === '1',
      })
      return result.summary
    },
    's12-smcvwap-calibration': async () => {
      const { runS12TwCalibration } = await import('./s12TwEquityCalibration')
      const cadence = c.req.query('cadence') === 'monthly'
        ? 'monthly'
        : c.req.query('cadence') === 'regime_shift'
          ? 'regime_shift'
          : 'weekly'
      const result = await runS12TwCalibration(c.env.DB, {
        runDate: requestedRunDate() ?? twToday(),
        cadence,
        dryRun: c.req.query('dry_run') === '1',
      })
      return result.summary
    },
    's12-research-recovery': async () => {
      const runDate = assertRunDate(requestedRunDate())
      const rawScheduleAt = String(c.req.query('schedule_at') ?? '').trim()
      const scheduleAtMs = rawScheduleAt ? Date.parse(rawScheduleAt) : Date.now()
      if (!Number.isFinite(scheduleAtMs)) throw new Error('invalid s12 recovery schedule_at')
      const delaySeconds = Math.max(0, Math.ceil((scheduleAtMs - Date.now()) / 1000))
      if (delaySeconds > 43_200) throw new Error('s12 recovery schedule exceeds Cloudflare Queue 12 hour delay limit')
      const runId = `s12-research-recovery-${runDate}-${Date.now().toString(36)}`
      await c.env.UPDATE_QUEUE.send({
        type: 's12_research_recovery',
        cursor: 0,
        triggerTime: runDate,
        runId,
      }, delaySeconds > 0 ? { delaySeconds } : undefined)
      return `scheduled s12 research recovery date=${runDate} schedule_at=${new Date(scheduleAtMs).toISOString()} delay_seconds=${delaySeconds} run_id=${runId}`
    },
    's12-replay-backfill': async () => {
      const runDate = assertRunDate(requestedRunDate())
      const requestedScope = c.req.query('scope')
      const replayScope = requestedScope === 'fusion_snapshot_missing'
        ? 'fusion_snapshot_missing'
        : requestedScope === 'fusion_snapshot_structure'
          ? 'fusion_snapshot_structure'
          : requestedScope === 'signed_eligible_repair'
            ? 'signed_eligible_repair'
          : 'l0'
      if (replayScope !== 'l0') {
        const runId = `manual-fusion-cohort-replay-${runDate}-${Date.now().toString(36)}`
        const maturityAsOfDate = c.req.query('as_of') ?? twToday()
        await c.env.UPDATE_QUEUE.send({
          type: 's12_replay_backfill_chunk',
          cursor: 0,
          triggerTime: runDate,
          runId,
          replayScope,
          maturityAsOfDate,
        } as any)
        return `triggered s12 replay backfill date=${runDate} scope=${replayScope} run_id=${runId} callback expected`
      }
      const { runS12HistoricalReplayForDate } = await import('./s12ReplayTradeOutcome')
      const result = await runS12HistoricalReplayForDate(c.env, runDate, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 500, 5000),
        offset: Math.max(0, parseBoundedPositiveInt(c.req.query('offset'), 0, 20000)),
        persist: c.req.query('dry_run') !== '1',
        maturityAsOfDate: c.req.query('as_of') ?? twToday(),
      })
      return [
        `s12_replay_backfill signal_date=${result.signal_date}`,
        `execution_dates=${result.execution_dates.join(',') || 'none'}`,
        `unresolved_execution_dates=${result.unresolved_execution_dates}`,
        `l0=${result.l0_symbols}`,
        `attempted=${result.attempted}`,
        `executed=${result.executed}`,
        `setup_only=${result.setup_only}`,
        `skipped=${result.skipped}`,
        `persisted=${result.persisted}`,
      ].join(' ')
    },
    'paper-trade': () => deps.runPaperAutoTrade(),
    'morning-setup': async () => {
      const { settlePaperT2 } = await import('./cronOrchestrator')
      const { loadPendingBuySnapshot } = await import('./pendingBuyStore')
      const { buildPendingBuyStateSummary } = await import('./pendingBuyStateSummary')
      const { formatPendingBuyCronSummary } = await import('./pendingBuyCronSummary')
      await settlePaperT2(c.env)
      await runMorningWarmup(c.env)
      await deps.setupMorningPendingBuys()
      const snapshot = await loadPendingBuySnapshot(c.env, twToday(), { allowFallbackRecent: false })
      const state = buildPendingBuyStateSummary(snapshot.pendingBuys, snapshot.meta)
      return formatPendingBuyCronSummary('morning setup done', state, { source: snapshot.source })
    },
    'intraday-check': () => {
      const h = (new Date().getUTCHours() + 8) % 24
      const m = new Date().getUTCMinutes()
      const open = h >= 9 && (h < 13 || (h === 13 && m <= 30))
      if (!open && !c.req.query('force')) return Promise.resolve('SKIPPED: 非台股盤中時段，請加 force=1')
      return deps.runIntradayCheck()
    },
    'eod-exit': () => {
      const h = (new Date().getUTCHours() + 8) % 24
      const m = new Date().getUTCMinutes()
      const twTime = h * 100 + m
      const validEod = twTime >= 1325 && twTime <= 1335
      if (!validEod && !c.req.query('force')) return Promise.resolve('SKIPPED: 僅限 EOD 13:25-13:35 TW，請加 force=1')
      return deps.runEODExit()
    },
    'post-close-price-refresh': async () => {
      const { refreshOpenPositionPostClosePriceCache } = await import('./paperIntradayPriceCache')
      const result = await refreshOpenPositionPostClosePriceCache(c.env, { tradeDate: requestedRunDate() })
      return result.summary
    },
    'daily-snapshot': () => deps.runDailySnapshot(requestedRunDate()),
    warmup: () => deps.runMorningWarmup(),
    'ml-warmup': () => runMlControllerWarmup(c.env),
    'pre-market-warmup': async () => {
      const { runPreMarketWarmup } = await import('./cronOrchestrator')
      const { reconcilePendingBuyDebates } = await import('./pendingBuyOrchestrator')
      const { loadPendingBuySnapshot } = await import('./pendingBuyStore')
      const { buildPendingBuyStateSummary } = await import('./pendingBuyStateSummary')
      const { formatPendingBuyCronSummary } = await import('./pendingBuyCronSummary')
      const warmup = await runPreMarketWarmup(c.env)
      const tradeDate = twToday()
      const setupError = await c.env.KV.get(`paper:pending_buys_setup_error:${tradeDate}`)
      const beforeRepair = await loadPendingBuySnapshot(c.env, tradeDate, { allowFallbackRecent: false })
      const needsRepair = Boolean(setupError) || beforeRepair.source === 'none' || beforeRepair.meta?.status === 'error'
      if (needsRepair) await deps.setupMorningPendingBuys()
      const debate = await reconcilePendingBuyDebates(c.env, twToday())
      const snapshot = await loadPendingBuySnapshot(c.env, twToday(), { allowFallbackRecent: false })
      const state = buildPendingBuyStateSummary(snapshot.pendingBuys, snapshot.meta)
      return formatPendingBuyCronSummary(warmup, state, {
        debate,
        morning_setup_repair: needsRepair ? 'rerun_completed' : 'not_needed',
      })
    },
    'intraday-rescore': async () => {
      const { runIntradayRescore } = await import('./cronOrchestrator')
      const cron = inferIntradayRescoreCron(c.req.query('cron'))
      const slotTask = RESCORE_SLOT_TASK_BY_CRON[cron]
      const runDate = twToday()
      const startedAt = Date.now()
      if (slotTask) {
        await logSchedulerResult(c.env.KV, slotTask, {
          status: 'running',
          summary: `started cron=${cron}`,
          duration_ms: 0,
          run_date: runDate,
          strict: true,
        })
      }
      try {
        const summary = await runIntradayRescore(c.env, cron, runDate)
        if (slotTask) {
          await logSchedulerResult(c.env.KV, slotTask, {
            status: classifySchedulerSummary(summary),
            summary,
            duration_ms: Date.now() - startedAt,
            run_date: runDate,
            strict: true,
          })
        }
        return summary
      } catch (error) {
        if (slotTask) {
          await logSchedulerResult(c.env.KV, slotTask, {
            status: 'error',
            summary: error instanceof Error ? error.message : String(error),
            duration_ms: Date.now() - startedAt,
            run_date: runDate,
            error: String(error),
            strict: true,
          })
        }
        throw error
      }
    },
    'morning-briefing': async () => {
      const { generateMorningBriefing } = await import('./morningBriefing')
      return generateMorningBriefing(c.env)
    },
    'daily-report': async () => {
      const { generateDailyReport } = await import('./dailyReport')
      return generateDailyReport(c.env)
    },
    'news-analyst': async () => {
      const { runDailyNewsAnalysis } = await import('./newsAnalyst')
      const report = await runDailyNewsAnalysis(c.env as any)
      return `bias=${report.bias} conf=${report.confidence.toFixed(2)} factors=${report.key_factors.length}`
    },
    'debate-memory-retention': async () => {
      const res = await c.env.DB.prepare(
        `DELETE FROM debate_memory WHERE debate_date < DATE('now', '-180 days')`,
      ).run()
      const meta = (res as any)?.meta ?? {}
      return `deleted=${meta.changes ?? 0} rows_read=${meta.rows_read ?? 0}`
    },
    'audit-json-retention': async () => {
      const {
        AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
        AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE,
        AUDIT_JSON_RETENTION_DEFAULT_DAYS,
        runAuditJsonArchiveRetention,
        summarizeAuditJsonArchiveRun,
      } = await import('./auditJsonArchive')
      const confirmPhrase = c.req.query('confirm_archive') ?? c.req.query('confirm')
      const dryRun = confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE
      const result = await runAuditJsonArchiveRetention(c.env, {
        businessDate: requestedRunDate(),
        retentionDays: Number.parseInt(c.req.query('retention_days') ?? `${AUDIT_JSON_RETENTION_DEFAULT_DAYS}`, 10),
        limitPerTable: Number.parseInt(c.req.query('limit_per_table') ?? `${AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE}`, 10),
        targets: c.req.queries('target') ?? (c.req.query('targets') ? [c.req.query('targets')] : null),
        dryRun,
        confirmPhrase,
      })
      const failed = result.tables.filter((table) => table.status === 'failed')
      if (failed.length) {
        throw new Error(`audit json retention failed ${JSON.stringify(failed)}`)
      }
      return summarizeAuditJsonArchiveRun(result)
    },
    'artifact-reconcile': async () => {
      const { runArtifactReconcile } = await import('./artifactLifecycle')
      const result = await runArtifactReconcile(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 250, 500),
      })
      if (result.missing || result.mismatched || result.errors.length) {
        throw new Error(`artifact reconcile failed ${JSON.stringify(result)}`)
      }
      return `artifact_reconcile checked=${result.checked} verified=${result.verified}`
    },
    'legacy-evidence-migration': async () => {
      const { runLegacyEvidenceMigration } = await import('./legacyEvidenceMigration')
      if (c.req.query('durable') === '1') {
        const { enqueueMaintenanceBacklogDrain } = await import('./maintenanceBacklogDrain')
        const queued = await enqueueMaintenanceBacklogDrain(c.env, {
          task: 'legacy-evidence-migration',
          runDate: requestedRunDate() || twToday(),
          maxAttempts: parseBoundedPositiveInt(c.req.query('max_attempts'), 240, 240),
        })
        return `legacy_evidence_migration durable=true queued=${queued.queued} run_id=${queued.runId}`
      }
      const chunkLimit = parseBoundedPositiveInt(c.req.query('limit'), 100, 500)
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 1, 10)
      const deadline = Date.now() + D1_MAINTENANCE_REQUEST_BUDGET_MS
      let candidates = 0
      let artifacts = 0
      let queuedScrubs = 0
      let backlogRemaining = false
      for (let chunk = 0; chunk < maxChunks; chunk += 1) {
        const result = await runLegacyEvidenceMigration(c.env, { limit: chunkLimit })
        candidates += result.candidates
        artifacts += result.artifacts
        queuedScrubs += result.queued_scrubs
        backlogRemaining = result.backlog_remaining
        if (!backlogRemaining || result.candidates === 0) break
        if (Date.now() >= deadline) break
      }
      return `legacy_evidence_migration candidates=${candidates} artifacts=${artifacts} queued_scrubs=${queuedScrubs} backlog_remaining=${backlogRemaining}`
    },
    'legacy-strategy-evidence-migration': async () => {
      const { runLegacyStrategyEvidenceMigration } = await import('./legacyStrategyEvidenceMigration')
      if (c.req.query('durable') === '1') {
        const { enqueueMaintenanceBacklogDrain } = await import('./maintenanceBacklogDrain')
        const queued = await enqueueMaintenanceBacklogDrain(c.env, {
          task: 'legacy-strategy-evidence-migration',
          runDate: requestedRunDate() || twToday(),
          maxAttempts: parseBoundedPositiveInt(c.req.query('max_attempts'), 240, 240),
        })
        return `legacy_strategy_evidence_migration durable=true queued=${queued.queued} run_id=${queued.runId}`
      }
      const symbolLimit = parseBoundedPositiveInt(c.req.query('symbol_limit'), 10, 40)
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 1, 10)
      const deadline = Date.now() + D1_MAINTENANCE_REQUEST_BUDGET_MS
      let contexts = 0
      let decisions = 0
      let artifacts = 0
      let originalBytes = 0
      let compactBytes = 0
      let backlogRemaining = false
      for (let chunk = 0; chunk < maxChunks; chunk += 1) {
        const result = await runLegacyStrategyEvidenceMigration(c.env, { symbolLimit })
        contexts += result.candidate_contexts
        decisions += result.migrated_decisions
        artifacts += result.artifacts
        originalBytes += result.original_blob_bytes
        compactBytes += result.compact_blob_bytes
        backlogRemaining = result.backlog_remaining
        if (!backlogRemaining || result.migrated_decisions === 0) break
        if (Date.now() >= deadline) break
      }
      return `legacy_strategy_evidence_migration contexts=${contexts} decisions=${decisions} artifacts=${artifacts} original_bytes=${originalBytes} compact_bytes=${compactBytes} backlog_remaining=${backlogRemaining}`
    },
    'legacy-hot-data-retirement': async () => {
      const {
        LEGACY_HOT_DATA_RETIREMENT_CONFIRM_PHRASE,
        runLegacyHotDataRetirement,
      } = await import('./legacyHotDataRetirement')
      const allowedTargets: LegacyHotDataTarget[] = [
        'obsolete_screener_items',
        'superseded_pending_items',
        'superseded_pending_events',
        'null_date_predictions',
        'intraday_report_manifests',
        'retired_state_space_shadow',
        'allocator_snapshot_staging_orphans',
      ]
      const requestedTargets = String(c.req.query('targets') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is LegacyHotDataTarget => allowedTargets.includes(value as LegacyHotDataTarget))
      const targets = requestedTargets.length ? requestedTargets : allowedTargets
      const limit = parseBoundedPositiveInt(c.req.query('limit'), 100, 500)
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 1, 5)
      const dryRun = c.req.query('confirm_retirement') !== LEGACY_HOT_DATA_RETIREMENT_CONFIRM_PHRASE
      const summaries: string[] = []
      for (const target of targets) {
        let archived = 0
        let deleted = 0
        let artifacts = 0
        let backlogRemaining = false
        for (let chunk = 0; chunk < (dryRun ? 1 : maxChunks); chunk += 1) {
          const result = await runLegacyHotDataRetirement(c.env, { target, limit, dryRun })
          archived += result.archived
          deleted += result.deleted
          artifacts += result.artifacts
          backlogRemaining = result.backlog_remaining
          if (!backlogRemaining || result.candidates === 0) break
        }
        summaries.push(`${target}:archived=${archived},deleted=${deleted},artifacts=${artifacts},backlog=${backlogRemaining}`)
      }
      return `legacy_hot_data_retirement dry_run=${dryRun} ${summaries.join(' ')}`
    },
    'd1-evidence-scrub': async () => {
      if (c.req.query('durable') === '1') {
        const { enqueueMaintenanceBacklogDrain } = await import('./maintenanceBacklogDrain')
        const queued = await enqueueMaintenanceBacklogDrain(c.env, {
          task: 'd1-evidence-scrub',
          runDate: requestedRunDate() || twToday(),
          maxAttempts: parseBoundedPositiveInt(c.req.query('max_attempts'), 240, 240),
          maxCycles: parseBoundedPositiveInt(c.req.query('max_cycles'), 4, 8),
        })
        return `d1_evidence_scrub durable=true queued=${queued.queued} run_id=${queued.runId}`
      }
      const { runD1EvidenceScrub } = await import('./artifactLifecycle')
      const result = await runD1EvidenceScrub(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 100, 1000),
      })
      if (result.failed || result.blocked) throw new Error(`d1 evidence scrub failed ${JSON.stringify(result)}`)
      return `d1_evidence_scrub candidates=${result.candidates} scrubbed=${result.scrubbed}`
    },
    'r2-retention-sweep': async () => {
      const { runR2RetentionSweep } = await import('./artifactLifecycle')
      const result = await runR2RetentionSweep(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 100, 1000),
      })
      if (result.failed) throw new Error(`r2 retention sweep failed ${JSON.stringify(result)}`)
      return `r2_retention_sweep candidates=${result.candidates} deleted=${result.deleted}`
    },
    'orphan-reachability-gc': async () => {
      const { runOrphanReachabilityGc } = await import('./artifactLifecycle')
      const result = await runOrphanReachabilityGc(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 500, 1000),
      })
      return `orphan_reachability_gc scanned=${result.scanned} deleted=${result.deleted} referenced=${result.referenced}`
    },
    'cleanup-dlq-replay': async () => {
      const { runCleanupDlqReplay } = await import('./artifactLifecycle')
      const result = await runCleanupDlqReplay(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 100, 500),
      })
      if (result.blocked) throw new Error(`cleanup dlq remains blocked ${JSON.stringify(result)}`)
      return `cleanup_dlq_replay candidates=${result.candidates} resolved=${result.resolved}`
    },
    'price-horizon-projection': async () => {
      const { materializePriceHorizonLabels } = await import('./priceHorizonProjection')
      const endDate = c.req.query('end_date') || requestedRunDate() || twToday()
      const result = await materializePriceHorizonLabels(c.env, {
        startDate: c.req.query('start_date') || undefined,
        endDate,
        outcomeAsOfDate: c.req.query('outcome_as_of_date') || twToday(),
        maxSignalDates: parseBoundedPositiveInt(c.req.query('max_signal_dates'), 60, 260),
        force: c.req.query('force') === '1',
      })
      return result.summary
    },
    'data-domain-shadow-backfill': async () => {
      const domain = String(c.req.query('domain') ?? '').trim().toLowerCase()
      const allowed = new Set(['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research'])
      if (!allowed.has(domain)) throw new Error('invalid data domain')
      const table = String(c.req.query('table') ?? '').trim().toLowerCase()
      if (c.req.query('durable') === '1') {
        const { enqueueDataDomainShadowBackfill } = await import('./dataDomainShadowBackfillDrain')
        const queued = await enqueueDataDomainShadowBackfill(c.env, {
          domain: domain as any,
          table: table || undefined,
          runDate: requestedRunDate() || twToday(),
          maxAttempts: parseBoundedPositiveInt(c.req.query('max_attempts'), 5000, 20000),
        })
        return `data_domain_shadow_backfill durable=true domain=${domain} queued=${queued.queued} run_id=${queued.runId}`
      }
      if (!table) throw new Error('data-domain-shadow-backfill requires table unless durable=1')
      const { backfillDataDomainTableShadow } = await import('./dataDomainShadowBackfill')
      const result = await backfillDataDomainTableShadow(c.env, {
        domain: domain as any,
        table,
        limit: parseBoundedPositiveInt(c.req.query('limit'), 50, 50),
        reset: c.req.query('reset') === '1',
      })
      return `data_domain_shadow_backfill ${JSON.stringify(result)}`
    },
    'storage-health-check': async () => {
      const { runStorageHealthCheck } = await import('./artifactLifecycle')
      const result = await runStorageHealthCheck(c.env)
      if (!result.healthy) throw new Error(`storage health check failed ${JSON.stringify(result)}`)
      return `storage_health_check ${JSON.stringify(result)}`
    },
    'storage-health-gate': async () => {
      const { runStorageHealthCheck } = await import('./artifactLifecycle')
      const result = await runStorageHealthCheck(c.env)
      if (!result.healthy) throw new Error(`legacy storage health alias failed ${JSON.stringify(result)}`)
      return `storage_health_gate_legacy_alias ${JSON.stringify(result)}`
    },
    'storage-integrity-audit': async () => {
      const { runArtifactIntegrityAudit } = await import('./artifactLifecycle')
      const result = await runArtifactIntegrityAudit(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 100, 500),
        includeBlocked: true,
      })
      if (result.missing || result.mismatched || result.errors.length) {
        throw new Error(`storage integrity audit failed ${JSON.stringify(result)}`)
      }
      return `storage_integrity_audit checked=${result.checked} verified=${result.verified}`
    },
    'storage-capacity-report': async () => {
      const { runStorageHealthCheck } = await import('./artifactLifecycle')
      const health = await runStorageHealthCheck(c.env)
      const { results } = await c.env.DB.prepare(`
        SELECT retention_class, status, COUNT(*) AS artifacts,
               COALESCE(SUM(byte_size), 0) AS bytes
          FROM run_artifacts
         GROUP BY retention_class, status
         ORDER BY retention_class, status
      `).all()
      return `storage_capacity_report health=${JSON.stringify(health)} classes=${JSON.stringify(results ?? [])}`
    },
    'timeverse-sync': async () => {
      const { syncTimeverse } = await import('./timeverse')
      return syncTimeverse(c.env)
    },
    'us-leading': async () => {
      const { fetchAndStoreUSLeading } = await import('./usLeading')
      return fetchAndStoreUSLeading(c.env)
    },
    adapt: async () => {
      const { runAdaptiveUpdate } = await import('./adaptiveEngine')
      return runAdaptiveUpdate(c.env)
    },
    'linucb-reward-ledger': async () => {
      const { runLinUcbRewardLedgerRefresh } = await import('./adaptiveEngine')
      return runLinUcbRewardLedgerRefresh(c.env, requestedRunDate())
    },
    'adaptive-meta-policy-replay': () => runAdaptiveMetaPolicyReplayTask(c, requestedRunDate()),
    'linucb-multiplier-replay': () => runLinUcbMultiplierReplayTask(c, requestedRunDate()),
    verify: async () => {
      return runVerifyV2(c.env)
    },
    'reclassify-tags': async () => {
      const { reclassifyTags } = await import('./tagReclassifier')
      return reclassifyTags(c.env)
    },
    'sync-industries': async () => {
      const { syncIndustryTags } = await import('./twseApi')
      return syncIndustryTags(c.env.DB, c.env.KV)
    },
    'factor-ic': async () => {
      const { calcFactorIC } = await import('./marketScreener')
      return calcFactorIC(c.env)
    },
    'mae-analysis': async () => {
      const { analyzeMAE } = await import('./marketScreener')
      return analyzeMAE(c.env)
    },
    pipeline: () => deps.runMLAndRiskV2(requestedRunDate()),
    'weekly-cleanup': async () => {
      const cleanup = await runWeeklyCleanup(c.env)
      const lifecycle = await deps.runWeeklyLifecycleCheck()
      const maintenance = await runWeeklyLocalMaintenance(c.env)
      if (!cleanup.ok || !maintenance.ok) {
        throw new Error(`weekly cleanup failed ${JSON.stringify({ cleanup, maintenance })}`)
      }
      return `weekly_cleanup_v2 cleanup=${JSON.stringify(cleanup)} maintenance=${JSON.stringify(maintenance)} lifecycle dry-run=${String(lifecycle)}`
    },
    'sector-leaders': async () => {
      const { computeSectorLeaders } = await import('./sectorCorrelation')
      const r = await computeSectorLeaders(c.env.DB)
      return `sectors=${r.sectorCount} leaders=${r.leaderCount}`
    },
    'neural-ucb-shadow': () => runNeuralShadowTask(c, 'NeuralUCB', requestedRunDate()),
    'neural-ts-shadow': () => runNeuralShadowTask(c, 'NeuralTS', requestedRunDate()),
    'neucb-shadow': () => runNeuralShadowTask(c, 'NeuCB', requestedRunDate()),
  }
  for (const taskName of D1_HEAVY_MAINTENANCE_TASKS) {
    const handler = tasks[taskName]
    if (!handler) continue
    tasks[taskName] = async () => summarizeMaintenanceLeaseResult(
      await runWithMaintenanceLease(c.env.DB, {
        taskName,
        leaseGroup: 'd1_heavy_maintenance',
        leaseSeconds: 300,
        run: handler,
      }),
    )
  }
  return tasks
}
