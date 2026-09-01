import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'
import { DATA_DOMAINS, databaseForDataDomain, databaseForTable, shadowDatabaseForDataDomain } from './dataDomainRegistry'
import type { DataDomain } from './dataDomainRegistry'
import { runVerifyV2 } from './controllerWorkflows'
import { twToday } from './dateUtils'
import { runMorningWarmup } from './localMaintenance'
import { runCadenceReadiness } from './cadenceReadiness'
import type { LegacyHotDataTarget } from './legacyHotDataRetirement'
import { runWithMaintenanceLease, summarizeMaintenanceLeaseResult } from './maintenanceLease'
import {
  resolveEveningChainClosureDurationMs,
  resolveEveningChainRunAuthority,
} from './eveningChainRunAuthority'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'
import { activeDataDomainShadowBackfillRunId } from './dataDomainShadowSession'

const RESCORE_SLOT_TASK_BY_CRON: Record<string, string> = {
  '0 2 * * 1-5': 'rescore-10',
  '0 3 * * 1-5': 'rescore-11',
  '0 4 * * 1-5': 'rescore-12',
  '30 4 * * 1-5': 'rescore-1230',
}
const RESCORE_CRONS = new Set(Object.keys(RESCORE_SLOT_TASK_BY_CRON))
const D1_HEAVY_MAINTENANCE_TASKS = new Set([
  'debate-memory-retention', 'audit-json-retention', 'retention-archive-only', 'retention-hot-window-drain', 'artifact-reconcile',
  'legacy-evidence-migration', 'legacy-strategy-evidence-migration',
  'legacy-hot-data-retirement', 'd1-evidence-scrub', 'r2-retention-sweep',
  'orphan-reachability-gc', 'cleanup-dlq-replay', 'weekly-cleanup',
  'price-horizon-projection',
  'canonical-selection-labels-rebuild',
  'strategy-evidence-owner-calibration',
  'strategy-learning-finalize',
  'selection-reference-repair', 'selection-reference-identity-repair',
  'data-domain-shadow-backfill',
  'data-domain-control-revision-trigger-install',
])
const D1_MAINTENANCE_REQUEST_BUDGET_MS = 45_000
const PAPER_SHADOW_BACKFILL_ACTIVE_KEY = 'data-domain-shadow-backfill:paper:active'
const AUDIT_JSON_NON_PAPER_TARGETS_DURING_PARITY_PROTECTION = [
  'strategy_decision_log', 'screener_funnel_items', 'canonical_screener_funnel_items',
]

const CUTOVER_PROBE_DOMAINS = new Set<DataDomain>(DATA_DOMAINS)

function resolveCutoverProbeDomain(rawDomain: string): DataDomain {
  const domain = rawDomain.trim().toLowerCase() as DataDomain
  if (!CUTOVER_PROBE_DOMAINS.has(domain)) {
    throw new Error(`data_domain_cutover_probe_not_yet_closed:${domain || 'missing'}`)
  }
  return domain
}
export function normalizeAndValidateAuditJsonTargets(
  rawTargets: Array<string | null | undefined>,
  allowedTargets: readonly string[],
): string[] {
  const normalizedTargets = rawTargets
    .flatMap((target) => String(target ?? '').split(','))
    .map((target) => target.trim())
  if (normalizedTargets.some((target) => !target)) {
    throw new Error('audit_json_retention_empty_target')
  }
  const requestedTargets = [...new Set(normalizedTargets)]
  const allowlist = new Set(allowedTargets)
  const unknownTargets = requestedTargets.filter((target) => !allowlist.has(target))
  if (unknownTargets.length) {
    throw new Error(`audit_json_retention_unknown_target:${unknownTargets.join(',')}`)
  }
  return requestedTargets
}

type WarmupSummary = {
  ok: boolean
  summary: string
}

async function paperShadowSourceMutationProtected(env: any): Promise<boolean> {
  const [active, cutover] = await Promise.all([
    env.KV.get(PAPER_SHADOW_BACKFILL_ACTIVE_KEY),
    // multi-d1-intentional-legacy-source: cutover authority is anchored in source DB.
    env.DB.prepare('SELECT status FROM data_domain_cutovers WHERE domain=?')
      .bind('paper').first(),
  ])
  const cutoverStatus = String((cutover as { status?: string } | null)?.status ?? 'legacy')
  return Boolean(active) || ['shadow', 'read_cutover', 'write_cutover'].includes(cutoverStatus)
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
  const summary = String(result.summary ?? `adaptive_meta_replay status=${result.status ?? 'unknown'}`)
  if (!persist) return summary
  const { reconcileAdaptiveMetaPolicy } = await import('./adaptiveMetaPolicyController')
  const runDate = String(result.source_query?.end_date ?? endDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw new Error('adaptive meta-policy controller missing replay end date')
  }
  const transition = await reconcileAdaptiveMetaPolicy(c.env, result, runDate)
  return `${summary} meta_controller=${transition.decision} phase=${transition.next_state.phase} `
    + `streak=${transition.next_state.consecutive_passes} mutation=${transition.mutation} reason=${transition.reason}`
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
  const screener = await databaseForDataDomain(c.env, 'ops').prepare(`
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
  const { enqueuePostScreenerPipelineContinuation } = await import('./postScreenerContinuation')
  const continuation = await enqueuePostScreenerPipelineContinuation(c.env, {
    triggerTime,
    runId,
    shardCount: 1,
    source: 'manual-admin-trigger',
  })

  return [
    `${continuation.queued ? 'triggered' : 'locked'} post-screener pipeline continuation for ${triggerTime}`,
    `run_id=${continuation.canonicalRunId}`,
    `screener_run_id=${screener.run_id}`,
    `final=${Number(screener.final_count ?? 0)}`,
    `emerging=${Number(screener.emerging_count ?? 0)}`,
    'callback expected',
  ].join('; ')
}

async function enqueueStrategyLearningMaterialization(c: any, runDate?: string): Promise<string> {
  const triggerTime = assertRunDate(runDate)
  const runId = `manual-strategy-learning-${triggerTime}-${Date.now().toString(36)}`
  const forcePolicy = c.req.query('force_policy') === '1'
  const productionRecovery = c.req.query('production_recovery') === '1'
  await c.env.UPDATE_QUEUE.send({
    type: 'strategy_learning_materialize',
    cursor: 0,
    triggerTime,
    runId,
    force: forcePolicy || productionRecovery,
    policyMutationAllowed: forcePolicy,
  })

  return [
    `triggered strategy-learning materialization for ${triggerTime}`,
    `run_id=${runId}`,
    `production_recovery=${productionRecovery}`,
    `policy_mutation=${forcePolicy}`,
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
    'strategy-learning-watchdog': async () => {
      const { runStrategyLearningRecoveryWatchdog } = await import('./strategyLearningRecoveryWatchdog')
      return runStrategyLearningRecoveryWatchdog(c.env, requestedRunDate())
    },
    'screener-v2-watchdog': async () => {
      if (!deps.runScreenerV2) throw new Error('screener-v2 trigger dependency not configured')
      const explicitDate = requestedRunDate()
      const screenerRunDate = assertRunDate(explicitDate || twToday())
      const [{ runScreenerRecoveryWatchdog }, { runStrategyLearningRecoveryWatchdog }] = await Promise.all([
        import('./screenerRecoveryWatchdog'),
        import('./strategyLearningRecoveryWatchdog'),
      ])
      const [screenerSummary, strategyLearningSummary] = await Promise.all([
        runScreenerRecoveryWatchdog(
          c.env,
          (_env, date, options) => deps.runScreenerV2!(date, options),
          screenerRunDate,
        ),
        runStrategyLearningRecoveryWatchdog(c.env, explicitDate),
      ])
      const compositeStatuses = [
        classifySchedulerSummary(screenerSummary),
        classifySchedulerSummary(strategyLearningSummary),
      ]
      const compositeStatus = compositeStatuses.includes('triggered')
        ? 'triggered'
        : compositeStatuses.includes('running')
          ? 'running'
          : compositeStatuses.every((status) => status === 'skipped') ? 'skipped' : 'success'
      return `status=${compositeStatus} screener={${screenerSummary}} strategy_learning={${strategyLearningSummary}}`
    },
    update: () => deps.runDailyUpdate(!!c.req.query('force'), requestedRunDate()),
    ml: () => deps.runMLAndRiskV2(requestedRunDate()),
    recommendation: () => deps.runDailyRecommendation(requestedRunDate()),
    'post-screener-pipeline': () => enqueuePostScreenerPipelineContinuation(c, requestedRunDate()),
    'strategy-learning': () => enqueueStrategyLearningMaterialization(c, requestedRunDate()),
    'strategy-learning-finalize': async () => {
      const runDate = assertRunDate(requestedRunDate())
      const {
        claimStrategyLearningPage,
        completeStrategyLearningRun,
        deferStrategyLearningFinalizer,
        failStrategyLearningRun,
        isStrategyLearningLeaseLost,
        loadStrategyLearningRun,
        markStrategyLearningRunFinalized,
        recordStrategyLearningPolicyClosure,
        startStrategyLearningLeaseHeartbeat,
        STRATEGY_LEARNING_LEASE_SECONDS,
      } = await import('./strategyLearningRunState')
      const {
        reconcileAndReleaseStrategyLearningFinalizedTelemetry,
        reconcileStrategyLearningFinalizedRetryFastPath,
      } = await import('./strategyLearningFinalizedTelemetry')
      const learningDb = databaseForDataDomain(c.env, 'learning')
      const runStateDb = databaseForDataDomain(c.env, 'ops')
      const runState = await loadStrategyLearningRun(runStateDb, runDate)
      if (!runState) throw new Error(`strategy_learning_run_missing:${runDate}`)
      const finalizedRetry = await reconcileStrategyLearningFinalizedRetryFastPath(
        runStateDb,
        c.env.KV,
        runState,
        {
          attemptId: `${runState.canonical_run_id}:manual-telemetry-reconcile:${Date.now().toString(36)}`,
        },
      )
      if (finalizedRetry === 'reconciled') {
        return `strategy_learning_finalize date=${runDate} already_finalized run_id=${runState.canonical_run_id}`
      }
      if (finalizedRetry === 'no_live_telemetry_lease') {
        return `strategy_learning_finalize date=${runDate} already_finalized_without_live_telemetry_lease run_id=${runState.canonical_run_id}`
      }
      if (finalizedRetry === 'authority_changed') {
        return `strategy_learning_finalize date=${runDate} already_finalized_authority_changed run_id=${runState.canonical_run_id}`
      }

      const {
        assertCanonicalStrategyDecisionGridParity,
        finalizeStrategyLearningEvidenceV5,
        repairHistoricalStrategyDecisionGrid,
      } = await import('./strategyLearning')
      const { logSchedulerResult } = await import('./schedulerRunLogger')
      const finalizerAttemptId = `${runState.canonical_run_id}:manual-finalize:${Date.now().toString(36)}`
      const leaseOwner = `${runState.canonical_run_id}:manual-finalize-lease:${crypto.randomUUID()}`
      const leaseIdentity = {
        businessDate: runDate,
        canonicalRunId: runState.canonical_run_id,
        leaseOwner,
      }
      const claimed = await claimStrategyLearningPage(runStateDb, {
        ...leaseIdentity,
        cursorSymbol: String(runState.cursor_symbol ?? ''),
        leaseSeconds: STRATEGY_LEARNING_LEASE_SECONDS,
      })
      if (!claimed) {
        throw new Error(`strategy_learning_finalizer_lease_busy:${runDate}:${runState.canonical_run_id}`)
      }
      let materializationValidated = false
      let durableFinalized = false
      let finalizerHeartbeat: ReturnType<typeof startStrategyLearningLeaseHeartbeat> | null = null
      try {
        await repairHistoricalStrategyDecisionGrid(learningDb, {
          date: runDate,
          canonicalProducerRunId: runState.producer_run_id,
        })
        await assertCanonicalStrategyDecisionGridParity(learningDb, {
          date: runDate,
          canonicalProducerRunId: runState.producer_run_id,
        })
        const coverage = await completeStrategyLearningRun(runStateDb, {
          ...leaseIdentity,
          leaseSeconds: STRATEGY_LEARNING_LEASE_SECONDS,
        })
        if (!coverage) {
          throw new Error(`strategy_learning_lease_lost:${runDate}:${runState.canonical_run_id}:${leaseOwner}`)
        }
        materializationValidated = true
        finalizerHeartbeat = startStrategyLearningLeaseHeartbeat(runStateDb, {
          ...leaseIdentity,
          leaseSeconds: STRATEGY_LEARNING_LEASE_SECONDS,
        })
        const assertFinalizerLease = async (_stage: string): Promise<void> => finalizerHeartbeat!.assertActive()
        const productionAuthorityIntent = runState.production_authority_intent === 1
        if (c.req.query('force_policy') === '1' && !productionAuthorityIntent) {
          throw new Error(`strategy_learning_durable_production_authority_intent_required:${runDate}`)
        }
        const productionAuthority = productionAuthorityIntent
          ? await resolveEveningChainRunAuthority(c.env, {
              businessDate: runDate,
              canonicalRunId: runState.canonical_run_id,
            })
          : null
        const currentBusinessDateRun = productionAuthority?.allowed === true
        const runScope = productionAuthority?.runScope ?? 'historical_replay'
        const authorityReason = productionAuthority?.reason ?? 'durable_run_not_marked_production_eligible'
        if (productionAuthorityIntent && !currentBusinessDateRun) {
          throw new Error(`strategy_learning_production_authority_denied:${runDate}:${authorityReason}`)
        }
        const chainDurationMs = await resolveEveningChainClosureDurationMs(c.env.DB, runDate)
        const {
          auditEveningChainEvidenceClosure,
          resolveExpectedMatureSignalDate,
          summarizeEveningChainEvidenceClosure,
        } = await import('./eveningChainEvidenceClosure')
        const historicalPriorityDate = await resolveExpectedMatureSignalDate(c.env, runDate)
        const { drainMatureSelectionEvidence } = await import('./matureSelectionEvidenceRecovery')
        await assertFinalizerLease('mature_recovery')
        const matureRecovery = await drainMatureSelectionEvidence(c.env, runDate, {
          maxRecoveryDates: 4,
          maxBatches: 3,
        })
        await assertFinalizerLease('mature_recovery')
        let closureSummary = ''
        const { decisionEvidence, historicalEvidence, labels, marginalEdge, routeBackfillEligibility, rewards, policy, productionPolicy }
          = await finalizeStrategyLearningEvidenceV5(learningDb, runDate, {
            allowPromotion: currentBusinessDateRun,
            persistPolicy: currentBusinessDateRun,
            historicalPriorityDate,
            identityDb: databaseForDataDomain(c.env, 'core'),
            assertLease: assertFinalizerLease,
            resolveCanonicalScreenerRunIds: async (asOfDate) => {
              const { loadCanonicalScreenerRunIds } = await import('./historicalScreenerArtifactEvidence')
              return loadCanonicalScreenerRunIds(c.env, asOfDate)
            },
            resolveHistoricalRegime: async (signalDate) => {
              const { readHistoricalHmmRegimeFamily } = await import('./marketRegimeState')
              return readHistoricalHmmRegimeFamily(
                c.env.KV,
                signalDate,
                databaseForDataDomain(c.env, 'market'),
              )
            },
            resolveHistoricalArtifactEvidence: async (signalDate, producerRunId) => {
              const { loadHistoricalScreenerArtifactEvidence } = await import('./historicalScreenerArtifactEvidence')
              return loadHistoricalScreenerArtifactEvidence(c.env, signalDate, producerRunId)
            },
            repairHistoricalDecisionGrid: (signalDate, producerRunId) => repairHistoricalStrategyDecisionGrid(
              learningDb,
              {
                date: signalDate,
                canonicalProducerRunId: producerRunId,
              },
            ),
            beforePromotion: async () => {
              const closureAudit = await auditEveningChainEvidenceClosure(
                c.env,
                runDate,
                String(runState.producer_run_id ?? ''),
                { requireSectorBreadth: currentBusinessDateRun },
              )
              closureSummary = summarizeEveningChainEvidenceClosure(closureAudit)
            },
          })
        if (!closureSummary) throw new Error('evening_chain_evidence_closure_callback_missing')
        if (currentBusinessDateRun && (!policy || !productionPolicy)) {
          throw new Error(`strategy_learning_live_policy_closure_missing:${runDate}`)
        }
        const policyClosureStatus = currentBusinessDateRun ? 'materialized' : 'evidence_only'
        const policyClosureReason = currentBusinessDateRun
          ? `live_canonical:${authorityReason}`
          : `historical_replay:${authorityReason}`
        await assertFinalizerLease('policy_closure')
        const policyClosureRecorded = await recordStrategyLearningPolicyClosure(runStateDb, {
          ...leaseIdentity,
          status: policyClosureStatus,
          reason: policyClosureReason,
        })
        if (!policyClosureRecorded) {
          throw new Error(`strategy_learning_policy_closure_fence_lost:${runDate}:${runState.canonical_run_id}`)
        }
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
        `production_policy=${productionPolicy ? productionPolicy.state.status : 'skipped_historical'}`,
        `evidence_closure=${closureSummary}`,
        `run_scope=${runScope}`,
        `production_authority=${authorityReason}`,
        `production_authority_intent=${productionAuthorityIntent}`,
        `policy_closure=${policyClosureStatus}`,
        ].join(' ')
        await assertFinalizerLease('finalize')
        const finalized = await markStrategyLearningRunFinalized(runStateDb, leaseIdentity)
        if (!finalized) {
          const deferred = await deferStrategyLearningFinalizer(runStateDb, {
            ...leaseIdentity,
            error: `strategy_learning_finalize_authority_lost:${runDate}:${runState.canonical_run_id}`,
          })
          if (!deferred) {
            throw new Error(`strategy_learning_lease_lost:${runDate}:${runState.canonical_run_id}:${leaseOwner}`)
          }
          return `strategy_learning_finalize date=${runDate} authority_lost_deferred`
        }
        durableFinalized = true
        const telemetryFinalized = await reconcileAndReleaseStrategyLearningFinalizedTelemetry(
          runStateDb,
          c.env.KV,
          leaseIdentity,
          {
            runDate,
            canonicalRunId: runState.canonical_run_id,
            summary,
            durationMs: chainDurationMs,
            attemptId: finalizerAttemptId,
            runScope,
          },
        )
        if (!telemetryFinalized) {
          throw new Error(`strategy_learning_finalized_telemetry_authority_lost:${runDate}:${runState.canonical_run_id}`)
        }
        return summary
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (durableFinalized) throw error
        if (isStrategyLearningLeaseLost(error)) {
          console.warn(`[Admin] strategy-learning lease lost; explicit retry required date=${runDate} run_id=${runState.canonical_run_id}`)
          throw error
        }
        const terminalPolicyClosureFailure = errorMessage.startsWith('strategy_learning_production_authority_denied:')
          || errorMessage.startsWith('strategy_learning_live_policy_closure_missing:')
          || errorMessage.startsWith('strategy_learning_durable_production_authority_intent_required:')
        const transitioned = materializationValidated && !terminalPolicyClosureFailure
          ? await deferStrategyLearningFinalizer(runStateDb, {
              ...leaseIdentity,
              error: errorMessage,
            })
          : await failStrategyLearningRun(runStateDb, {
              ...leaseIdentity,
            error: errorMessage,
          })
        if (!transitioned) {
          console.warn(`[Admin] strategy-learning terminal fence lost; explicit retry required date=${runDate} run_id=${runState.canonical_run_id}`)
          throw error
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
      } finally {
        await finalizerHeartbeat?.stop()
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
    's12-smcvwap-calibration': async () => {
      throw new Error('s12 calibration requires durable queue execution')
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
      const offset = Math.max(0, parseBoundedPositiveInt(c.req.query('offset'), 0, 20000))
      const limit = parseBoundedPositiveInt(c.req.query('limit'), 500, 5000)
      const runId = `manual-l0-replay-${runDate}-${Date.now().toString(36)}`
      await c.env.UPDATE_QUEUE.send({
        type: 's12_replay_backfill_chunk',
        cursor: offset,
        triggerTime: runDate,
        runId,
        replayScope: 'l0',
        maturityAsOfDate: c.req.query('as_of') ?? twToday(),
        replayEndOffset: offset + limit,
        replayPersist: c.req.query('dry_run') !== '1',
      } as any)
      return `scheduled s12 replay backfill date=${runDate} scope=l0 offset=${offset} limit=${limit} run_id=${runId} callback expected`
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
    'daily-execution-paper-lineage': async () => {
      const { ensureDailyExecutionPaperClosureArtifacts } = await import('./dailyExecutionPaperLineage')
      const result = await ensureDailyExecutionPaperClosureArtifacts(c.env, requestedRunDate() || twToday())
      return `daily_execution_paper_lineage ${JSON.stringify(result)}`
    },
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
      const res = await databaseForTable(c.env, 'debate_memory').prepare(
        `DELETE FROM debate_memory WHERE debate_date < DATE('now', '-180 days')`,
      ).run()
      const meta = (res as any)?.meta ?? {}
      return `deleted=${meta.changes ?? 0} rows_read=${meta.rows_read ?? 0}`
    },
    'audit-json-retention': async () => {
      const {
        AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
        AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE,
        AUDIT_JSON_ARCHIVE_MIN_BLOB_BYTES,
        AUDIT_JSON_ARCHIVE_TARGET_IDS,
        AUDIT_JSON_RETENTION_DEFAULT_DAYS,
        runAuditJsonArchiveRetention,
        summarizeAuditJsonArchiveRun,
      } = await import('./auditJsonArchive')
      const confirmPhrase = c.req.query('confirm_archive') ?? c.req.query('confirm')
      const dryRun = confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE
      const durableRequested = c.req.query('durable') === '1'
      const groupedAuditTargets = c.req.query('targets')
      const requestedAuditTargets = normalizeAndValidateAuditJsonTargets([
        ...(c.req.queries('target') ?? []),
        ...(groupedAuditTargets === undefined ? [] : [groupedAuditTargets]),
      ], AUDIT_JSON_ARCHIVE_TARGET_IDS)
      if (durableRequested && dryRun) {
        throw new Error('audit_json_durable_requires_confirm_archive')
      }
      const retentionDays = Number.parseInt(
        c.req.query('retention_days') ?? `${AUDIT_JSON_RETENTION_DEFAULT_DAYS}`,
        10,
      )
      const limitPerTable = Number.parseInt(
        c.req.query('limit_per_table') ?? `${AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE}`,
        10,
      )
      const minBlobBytes = Number.parseInt(
        c.req.query('min_blob_bytes') ?? `${AUDIT_JSON_ARCHIVE_MIN_BLOB_BYTES}`,
        10,
      )
      const paperShadowProtected = await paperShadowSourceMutationProtected(c.env)
      const auditTargets = paperShadowProtected
        ? (requestedAuditTargets?.length
          ? requestedAuditTargets.filter((target) => target !== 'paper_execution_events')
          : AUDIT_JSON_NON_PAPER_TARGETS_DURING_PARITY_PROTECTION)
        : (requestedAuditTargets.length ? requestedAuditTargets : null)
      if (paperShadowProtected && auditTargets?.length === 0) {
        return 'audit_json_retention skipped=paper_execution_events reason=paper_shadow_parity_protected'
      }
      if (durableRequested) {
        const { enqueueMaintenanceBacklogDrain } = await import('./maintenanceBacklogDrain')
        const queued = await enqueueMaintenanceBacklogDrain(c.env, {
          task: 'audit-json-retention',
          runDate: requestedRunDate() || twToday(),
          maxAttempts: parseBoundedPositiveInt(c.req.query('max_attempts'), 240, 240),
          auditJsonOptions: {
            targets: auditTargets?.length ? [...auditTargets] : [...AUDIT_JSON_ARCHIVE_TARGET_IDS],
            retentionDays,
            limitPerTable,
            minBlobBytes,
          },
        })
        return `audit_json_retention durable=true queued=${queued.queued} run_id=${queued.runId}`
      }
      const result = await runAuditJsonArchiveRetention(c.env, {
        businessDate: requestedRunDate(),
        retentionDays,
        limitPerTable,
        minBlobBytes,
        targets: auditTargets,
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
      const obsoleteScreenerOnly = targets.length === 1 && targets[0] === 'obsolete_screener_items'
      const maxChunksCap = obsoleteScreenerOnly ? 20 : 5
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 1, maxChunksCap)
      const dryRun = c.req.query('confirm_retirement') !== LEGACY_HOT_DATA_RETIREMENT_CONFIRM_PHRASE
      const summaries: string[] = []
      const paperShadowProtected = await paperShadowSourceMutationProtected(c.env)
      const opsShadowBackfillRunId = dryRun
        ? null
        : await activeDataDomainShadowBackfillRunId(c.env.KV, 'ops')
      const retentionRunId = `legacy-hot-data-retirement:legacy_hot_r2_v1:`
        + `${requestedRunDate() || twToday()}:${Date.now().toString(36)}`
      const totals = { scanned: 0, archived: 0, deleted: 0 }
      const retentionOpsDb = databaseForDataDomain(c.env, 'ops')
      const { beginRetentionRun, finishRetentionRun } = await import('./retentionRunLedger')
      if (!dryRun) {
        await beginRetentionRun(retentionOpsDb, {
          runId: retentionRunId,
          policyId: 'legacy_hot_r2_v1',
          businessDate: requestedRunDate() || twToday(),
        })
      }
      try {
        for (const target of targets) {
          if (opsShadowBackfillRunId) {
            summaries.push(`${target}:skipped=ops_shadow_backfill_active,run_id=${opsShadowBackfillRunId}`)
            continue
          }
          if (paperShadowProtected && target === 'superseded_pending_events') {
            summaries.push('superseded_pending_events:skipped=paper_shadow_parity_protected')
            continue
          }
          let archived = 0
          let deleted = 0
          let artifacts = 0
          let backlogRemaining = false
          for (let chunk = 0; chunk < (dryRun ? 1 : maxChunks); chunk += 1) {
            const result = await runLegacyHotDataRetirement(c.env, { target, limit, dryRun })
            totals.scanned += result.candidates
            archived += result.archived
            deleted += result.deleted
            artifacts += result.artifacts
            backlogRemaining = result.backlog_remaining
            if (!backlogRemaining || result.candidates === 0) break
          }
          totals.archived += archived
          totals.deleted += deleted
          summaries.push(`${target}:archived=${archived},deleted=${deleted},artifacts=${artifacts},backlog=${backlogRemaining}`)
        }
        if (!dryRun) {
          await finishRetentionRun(retentionOpsDb, {
            runId: retentionRunId,
            status: 'success',
            scannedRows: totals.scanned,
            archivedRows: totals.archived,
            deletedRows: totals.deleted,
          })
        }
      } catch (error) {
        if (!dryRun) {
          await finishRetentionRun(retentionOpsDb, {
            runId: retentionRunId,
            status: 'error',
            scannedRows: totals.scanned,
            archivedRows: totals.archived,
            deletedRows: totals.deleted,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      }
      return `legacy_hot_data_retirement dry_run=${dryRun} run_id=${dryRun ? 'none' : retentionRunId} ${summaries.join(' ')}`
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
      const {
        materializePriceHorizonLabels,
        materializeStrategyMultiHorizonPriceLabels,
      } = await import('./priceHorizonProjection')
      const { materializeStrategyMultiHorizonOutcomes } = await import('./strategyMultiHorizonOutcomes')
      const { materializeStrategyEvidenceMetrics } = await import('./strategyEvidenceMetrics')
      const endDate = c.req.query('end_date') || requestedRunDate() || twToday()
      const outcomeAsOfDate = c.req.query('outcome_as_of_date') || twToday()
      const startDate = c.req.query('start_date') || undefined
      const maxSignalDates = parseBoundedPositiveInt(c.req.query('max_signal_dates'), 60, 260)
      const maxProcessDates = parseBoundedPositiveInt(c.req.query('max_process_dates'), 8, 40)
      const force = c.req.query('force') === '1'
      const canonical = await materializePriceHorizonLabels(c.env, {
        startDate,
        endDate,
        outcomeAsOfDate,
        maxSignalDates,
        maxProcessDates,
        force,
      })
      const multiHorizon = await materializeStrategyMultiHorizonPriceLabels(c.env, {
        startDate,
        endDate,
        outcomeAsOfDate,
        maxSignalDates,
        maxProcessDates,
        force,
      })
      if (c.req.query('projection_only') === '1') {
        return `${canonical.summary} | ${multiHorizon.summary} | downstream=skipped_by_explicit_projection_only`
      }
      const outcomes = await materializeStrategyMultiHorizonOutcomes(c.env, {
        asOfDate: outcomeAsOfDate,
        startDate,
        endDate,
      })
      const metrics = await materializeStrategyEvidenceMetrics(c.env, { outcomeAsOfDate })
      return `${canonical.summary} | ${multiHorizon.summary} | ${outcomes.summary} | ${metrics.summary}`
    },
    'canonical-selection-labels-rebuild': async () => {
      const asOfDate = c.req.query('as_of_date') || requestedRunDate() || twToday()
      const { materializeCanonicalSelectionLabelsV4 } = await import('./canonicalSelectionLabels')
      const { loadCanonicalScreenerRunIds } = await import('./historicalScreenerArtifactEvidence')
      const canonicalRunIds = await loadCanonicalScreenerRunIds(c.env, asOfDate)
      const labels = await materializeCanonicalSelectionLabelsV4(
        databaseForDataDomain(c.env, 'learning'),
        { asOfDate, canonicalRunIds },
      )
      return `canonical_selection_labels_rebuild as_of_date=${asOfDate} persisted=${labels.persisted_rows} pending=${labels.pending_rows} unavailable=${labels.unavailable_rows} idempotent=${labels.persisted_rows === 0}`
    },
    'strategy-evidence-metrics': async () => {
      const { materializeStrategyEvidenceMetrics } = await import('./strategyEvidenceMetrics')
      const outcomeAsOfDate = c.req.query('outcome_as_of_date') || twToday()
      const sourceMode = c.req.query('source_mode') === 'learning_target'
        ? 'learning_target'
        : 'authority_bridge'
      const metrics = await materializeStrategyEvidenceMetrics(c.env, {
        outcomeAsOfDate,
        sourceMode,
      })
      if (metrics.observations <= 0 || metrics.metric_rows <= 0) {
        throw new Error('strategy_evidence_metrics_refresh_empty')
      }
      return metrics.summary
    },
    'strategy-evidence-owner-calibration': async () => {
      const { refreshStrategyEvidenceOwnerCalibration } = await import('./strategyEvidenceOwnerCalibration')
      const knowledgeCutoffDate = c.req.query('knowledge_cutoff_date') || requestedRunDate() || twToday()
      const allowPromotion = c.req.query('allow_promotion') === '1'
      if (allowPromotion && c.req.header('X-Confirm-Strategy-Evidence-Owner-Calibration') !== 'true') {
        throw new Error('strategy_evidence_owner_calibration_promotion_requires_confirmation')
      }
      const calibration = await refreshStrategyEvidenceOwnerCalibration(c.env, {
        knowledgeCutoffDate,
        allowPromotion,
      })
      return `strategy_evidence_owner_calibration status=${calibration.result.status} run_id=${calibration.runId} dates=${calibration.result.dateCount} oos=${calibration.result.oosDates.length} delta_lcb90=${calibration.result.challengerDeltaLcb90 ?? 'null'}`
    },
    'data-domain-shadow-backfill': async () => {
      const domain = String(c.req.query('domain') ?? '').trim().toLowerCase()
      const allowed = new Set(['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research'])
      if (!allowed.has(domain)) throw new Error('invalid data domain')
      const table = String(c.req.query('table') ?? '').trim().toLowerCase()
      if (c.req.query('carry_forward') === '1') {
        if (c.req.header('X-Confirm-Data-Domain-Parity-Carry-Forward') !== 'true') {
          throw new Error('data-domain-shadow-backfill carry_forward requires explicit confirmation')
        }
        const parityNotBefore = String(c.req.query('parity_not_before') ?? '').trim()
        const { carryForwardStableDataDomainParityReceipts } = await import('./dataDomainShadowBackfillDrain')
        const result = await carryForwardStableDataDomainParityReceipts(
          c.env,
          domain as any,
          parityNotBefore,
        )
        return `data_domain_shadow_backfill carry_forward=true ${JSON.stringify(result)}`
      }
      if (c.req.query('durable') === '1') {
        if (c.req.query('direct_step') === '1') {
          const {
            inspectLatestEveningChainClosure,
            runDataDomainShadowBackfillHttpStep,
          } = await import('./dataDomainShadowBackfillDrain')
          const closure = await inspectLatestEveningChainClosure(c.env.KV, c.env.DB)
          if (!closure.terminalSuccess || !closure.timestamp) {
            return `skipped: data_domain_shadow_backfill direct_step ${closure.reason}`
          }
          const step = await runDataDomainShadowBackfillHttpStep(c.env, {
            domain: domain as any,
            parityNotBefore: closure.timestamp,
            runDate: requestedRunDate() || twToday(),
            table: table || undefined,
            limit: parseBoundedPositiveInt(c.req.query('limit'), 50, 1000),
          })
          return `data_domain_shadow_backfill direct_step=true ${JSON.stringify(step)}`
        }
        const {
          enqueueDataDomainShadowBackfill,
          inspectLatestEveningChainClosure,
        } = await import('./dataDomainShadowBackfillDrain')
        const closure = await inspectLatestEveningChainClosure(c.env.KV, c.env.DB)
        if (!closure.terminalSuccess || !closure.timestamp) {
          return `skipped: data_domain_shadow_backfill durable ${closure.reason}`
        }
        const queued = await enqueueDataDomainShadowBackfill(c.env, {
          domain: domain as any,
          parityNotBefore: closure.timestamp,
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
    'data-domain-shadow-backfill-next': async () => {
      const [
        {
          enqueueNextDataDomainShadowBackfill,
          inspectLatestEveningChainClosure,
        },
        { inspectDataDomainBackfillRetirementReadiness },
      ] = await Promise.all([
        import('./dataDomainShadowBackfillDrain'),
        import('./dataDomainBackfillRetirementReadiness'),
      ])
      const readiness = await inspectDataDomainBackfillRetirementReadiness(c.env.DB, c.env.KV)
      if (readiness.retirement_data_plane_ready) {
        return `data_domain_shadow_backfill_next all_domains_caught_up=true retirement_data_plane_ready=true observed_at=${readiness.observed_at}`
      }
      const closure = await inspectLatestEveningChainClosure(c.env.KV, c.env.DB)
      if (!closure.terminalSuccess) {
        return `skipped: data_domain_shadow_backfill_next ${closure.reason} run_date=${closure.runDate ?? 'missing'}`
      }
      const next = await enqueueNextDataDomainShadowBackfill(c.env, {
        runDate: closure.runDate!,
        maxAttempts: parseBoundedPositiveInt(c.req.query('max_attempts'), 5000, 20000),
        parityNotBefore: closure.timestamp,
      })
      if (next.caughtUp) {
        const refreshedReadiness = await inspectDataDomainBackfillRetirementReadiness(c.env.DB, c.env.KV)
        if (refreshedReadiness.retirement_data_plane_ready) {
          return `data_domain_shadow_backfill_next all_domains_caught_up=true retirement_data_plane_ready=true observed_at=${refreshedReadiness.observed_at}`
        }
        const blockers = refreshedReadiness.blockers.slice(0, 8).join('|') || 'unknown'
        return `skipped: data_domain_shadow_backfill_next retirement_data_plane_not_ready blockers=${blockers}`
      }
      return `data_domain_shadow_backfill_next domain=${next.domain} queued=${next.queued} run_id=${next.runId}`
    },
    'data-domain-control-revision-trigger-install': async () => {
      if (c.req.header('X-Confirm-Data-Domain-Control-Revision') !== 'true') {
        throw new Error(
          'data-domain-control-revision-trigger-install requires '
          + 'X-Confirm-Data-Domain-Control-Revision:true',
        )
      }
      const learningDb = shadowDatabaseForDataDomain(c.env, 'learning')
      if (!learningDb) throw new Error('data_domain_shadow_binding_missing:learning')
      const { installDataDomainControlRevisionTriggers } = await import('./dataDomainControlRevision')
      const legacy = await installDataDomainControlRevisionTriggers(c.env.DB)
      const learning = await installDataDomainControlRevisionTriggers(learningDb)
      return `data_domain_control_revision_trigger_install legacy=${JSON.stringify(legacy)} learning=${JSON.stringify(learning)}`
    },
    'data-domain-writer-epoch-trigger-install': async () => {
      if (c.req.header('X-Confirm-Data-Domain-Writer-Epoch') !== 'true') {
        throw new Error(
          'data-domain-writer-epoch-trigger-install requires '
          + 'X-Confirm-Data-Domain-Writer-Epoch:true',
        )
      }
      const requestedDomain = resolveCutoverProbeDomain(String(c.req.query('domain') ?? 'ops'))
      const { installDataDomainWriterEpochTriggers } = await import('./dataDomainWriterEpoch')
      const installed = await installDataDomainWriterEpochTriggers(c.env.DB, requestedDomain)
      return `data_domain_writer_epoch_trigger_install ${JSON.stringify(installed)}`
    },
    'data-domain-cutover-probe': async () => {
      if (c.req.header('X-Confirm-Data-Domain-Cutover-Probe') !== 'true') {
        throw new Error(
          'data-domain-cutover-probe requires '
          + 'X-Confirm-Data-Domain-Cutover-Probe:true',
        )
      }
      const requestedDomain = resolveCutoverProbeDomain(String(c.req.query('domain') ?? 'ops'))
      const targetDb = shadowDatabaseForDataDomain(c.env, requestedDomain)
      if (!targetDb) throw new Error(`data_domain_shadow_binding_missing:${requestedDomain}`)
      // multi-d1-intentional-legacy-source: canary binds the source authority receipt.
      const cutover = await c.env.DB.prepare(`
        SELECT status, parity_checked_at
          FROM data_domain_cutovers
         WHERE domain=?
      `).bind(requestedDomain).first() as { status?: string; parity_checked_at?: string } | null
      if (cutover?.status !== 'shadow') {
        throw new Error(`data_domain_cutover_probe_shadow_required:${requestedDomain}:${cutover?.status ?? 'missing'}`)
      }
      const { runDataDomainCutoverProbe } = await import('./dataDomainWriterEpoch')
      const receipt = await runDataDomainCutoverProbe({
        sourceDb: c.env.DB,
        targetDb,
        domain: requestedDomain,
        parityCheckedAt: String(cutover.parity_checked_at ?? ''),
      })
      return `data_domain_cutover_probe ${JSON.stringify(receipt)}`
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
      // Capacity is wall-clock telemetry. Historical scheduler replays must not
      // write today's bytes into an earlier observation date.
      const observedDate = twToday()
      const lineageRunDate = requestedRunDate() || observedDate
      const { runStorageHealthCheck } = await import('./artifactLifecycle')
      const {
        inspectStorageCapacityTelemetry,
        buildStorageCapacityGrowthEstimate,
      } = await import('./storageCapacityTelemetry')
      const health = await runStorageHealthCheck(c.env)
      const opsDb = databaseForDataDomain(c.env, 'ops')
      const [{ results }, currentRows, capacityHistory, backfillBaselines] = await Promise.all([
        opsDb.prepare(`
          SELECT retention_class, status, COUNT(*) AS artifacts,
                 COALESCE(SUM(byte_size), 0) AS bytes
            FROM run_artifacts
           GROUP BY retention_class, status
           ORDER BY retention_class, status
        `).all(),
        inspectStorageCapacityTelemetry(c.env),
        opsDb.prepare(`
          SELECT domain, binding_name, used_bytes, observed_date
            FROM storage_capacity_daily
           WHERE observed_date >= date(?, '-45 days')
             AND date(observed_at, '+8 hours') = observed_date
           ORDER BY observed_date ASC, observed_at ASC
        `).bind(observedDate).all<{
          domain: string
          binding_name: string
          used_bytes: number
          observed_date: string
        }>(),
        opsDb.prepare(`
          SELECT domain, substr(MAX(updated_at), 1, 10) AS baseline_after
            FROM data_domain_backfill_cursors
           GROUP BY domain
        `).all() as Promise<{
          results: Array<{ domain: string; baseline_after: string }>
        }>,
      ])
      const baselineByDomain = new Map(
        backfillBaselines.results.map((row) => [row.domain, row.baseline_after] as const),
      )
      const legacyBaseline = [...baselineByDomain.values()].sort().at(-1) ?? null
      const capacities = currentRows.map((row) => {
        const history = (capacityHistory.results ?? [])
          .filter((point) => point.binding_name === row.binding_name)
          .map((point) => ({ observed_date: point.observed_date, used_bytes: Number(point.used_bytes) }))
        history.push({ observed_date: observedDate, used_bytes: row.used_bytes })
        const estimate = buildStorageCapacityGrowthEstimate({
          currentUsedBytes: row.used_bytes,
          maxBytes: row.max_bytes,
          history,
          baselineAfter: row.domain === 'legacy'
            ? legacyBaseline
            : baselineByDomain.get(row.domain) ?? null,
        })
        const { status: forecastStatus, ...forecast } = estimate
        return {
          domain: row.domain,
          binding: row.binding_name,
          used: row.used_bytes,
          max: row.max_bytes,
          utilization_pct: row.utilization_pct,
          status: row.status,
          forecast_status: forecastStatus,
          ...forecast,
        }
      })
      return `storage_capacity_report observed_date=${observedDate} lineage_run_date=${lineageRunDate} health=${JSON.stringify(health)} d1=${JSON.stringify(capacities)} classes=${JSON.stringify(results ?? [])}`
    },
    'learning-retention-readiness': async () => {
      const { inspectLearningTenYearRetentionReadiness } = await import('./learningTenYearRetentionReadiness')
      const result = await inspectLearningTenYearRetentionReadiness(
        databaseForDataDomain(c.env, 'learning'),
        databaseForDataDomain(c.env, 'ops'),
        requestedRunDate() || twToday(),
      )
      return `learning_retention_readiness ${JSON.stringify(result)}`
    },
    'retention-archive-only': async () => {
      const {
        RETENTION_ARCHIVE_ONLY_POLICY_IDS,
        runRetentionArchiveOnly,
        summarizeRetentionArchiveOnly,
      } = await import('./retentionArchiveOnly')
      const requestedPolicies = (c.req.query('policies') ?? '')
        .split(',')
        .map((value: string) => value.trim())
        .filter(Boolean)
      const allowed = new Set<string>(RETENTION_ARCHIVE_ONLY_POLICY_IDS)
      const unknown = requestedPolicies.filter((policy: string) => !allowed.has(policy))
      if (unknown.length) throw new Error(`retention_archive_only_unknown_policy:${unknown.join(',')}`)
      const result = await runRetentionArchiveOnly(c.env, {
        businessDate: requestedRunDate() || twToday(),
        policyIds: requestedPolicies.length ? requestedPolicies as any : undefined,
        limitPerDataset: parseBoundedPositiveInt(c.req.query('limit_per_dataset'), 100, 250),
      })
      if (result.status === 'error') {
        throw new Error(`retention archive only failed ${JSON.stringify(result)}`)
      }
      return summarizeRetentionArchiveOnly(result)
    },
    'retention-hot-window-drain': async () => {
      const {
        RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS,
        runRetentionHotWindowDrain,
        summarizeRetentionHotWindowDrain,
      } = await import('./retentionHotWindowDrain')
      const requestedPolicies = (c.req.query('policies') ?? '')
        .split(',')
        .map((value: string) => value.trim())
        .filter(Boolean)
      const allowed = new Set<string>(RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS)
      const unknown = requestedPolicies.filter((policy: string) => !allowed.has(policy))
      if (unknown.length) throw new Error(`retention_hot_drain_unknown_policy:${unknown.join(',')}`)
      const result = await runRetentionHotWindowDrain(c.env, {
        businessDate: requestedRunDate() || twToday(),
        policyIds: requestedPolicies.length ? requestedPolicies as any : undefined,
        limitPerDataset: parseBoundedPositiveInt(c.req.query('limit_per_dataset'), 100, 250),
        confirmPhrase: c.req.query('confirm_drain'),
      })
      if (result.status === 'error') throw new Error(`retention hot window drain failed ${JSON.stringify(result)}`)
      return summarizeRetentionHotWindowDrain(result)
    },
    'legacy-learning-deletion-readiness': async () => {
      const { inspectLegacyLearningDeletionReadiness } = await import('./learningTenYearRetentionReadiness')
      const result = await inspectLegacyLearningDeletionReadiness(
        c.env.DB,
        databaseForDataDomain(c.env, 'learning'),
        requestedRunDate() || twToday(),
      )
      return `legacy_learning_deletion_readiness ${JSON.stringify(result)}`
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
    'weekly-readiness': () => runCadenceReadiness(c.env, 'weekly', requestedRunDate()),
    'monthly-readiness': () => runCadenceReadiness(c.env, 'monthly', requestedRunDate()),
    'weekly-cleanup': async () => {
      const { runWeeklyCleanupClosure } = await import('./durableSchedulerTask')
      return runWeeklyCleanupClosure(c.env, deps.runWeeklyModelRegistryCheck)
    },
    'sector-leaders': async () => {
      const { computeSectorLeaders } = await import('./sectorCorrelation')
      const r = await computeSectorLeaders(c.env)
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
