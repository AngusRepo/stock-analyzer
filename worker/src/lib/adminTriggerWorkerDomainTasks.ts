import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'
import { runVerifyV2 } from './controllerWorkflows'
import { twToday } from './dateUtils'
import { runMorningWarmup, runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'
import type { LegacyHotDataTarget } from './legacyHotDataRetirement'

const RESCORE_CRONS = new Set(['0 2 * * 1-5', '0 3 * * 1-5', '0 4 * * 1-5', '30 4 * * 1-5'])

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

  return {
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
    's12-replay-backfill': async () => {
      const runDate = assertRunDate(requestedRunDate())
      const requestedScope = c.req.query('scope')
      const replayScope = requestedScope === 'fusion_snapshot_missing'
        ? 'fusion_snapshot_missing'
        : requestedScope === 'fusion_snapshot_structure'
          ? 'fusion_snapshot_structure'
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
      return runIntradayRescore(c.env, inferIntradayRescoreCron(c.req.query('cron')), twToday())
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
        runAuditJsonArchiveRetention,
        summarizeAuditJsonArchiveRun,
      } = await import('./auditJsonArchive')
      const confirmPhrase = c.req.query('confirm_archive') ?? c.req.query('confirm')
      const dryRun = confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE
      const retentionRaw = c.req.query('retention_days')
      const result = await runAuditJsonArchiveRetention(c.env, {
        businessDate: requestedRunDate(),
        retentionDays: retentionRaw == null ? undefined : Number.parseInt(retentionRaw, 10),
        limitPerTable: Number.parseInt(c.req.query('limit_per_table') ?? `${AUDIT_JSON_ARCHIVE_DEFAULT_LIMIT_PER_TABLE}`, 10),
        targets: c.req.queries('target') ?? (c.req.query('targets') ? [c.req.query('targets')] : null),
        dryRun,
        confirmPhrase,
      })
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
      const chunkLimit = parseBoundedPositiveInt(c.req.query('limit'), 500, 500)
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 5, 10)
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
      }
      return `legacy_evidence_migration candidates=${candidates} artifacts=${artifacts} queued_scrubs=${queuedScrubs} backlog_remaining=${backlogRemaining}`
    },
    'legacy-strategy-evidence-migration': async () => {
      const { runLegacyStrategyEvidenceMigration } = await import('./legacyStrategyEvidenceMigration')
      const symbolLimit = parseBoundedPositiveInt(c.req.query('symbol_limit'), 20, 40)
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 5, 10)
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
      const limit = parseBoundedPositiveInt(c.req.query('limit'), 250, 500)
      const maxChunks = parseBoundedPositiveInt(c.req.query('max_chunks'), 2, 5)
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
      const { runD1EvidenceScrub } = await import('./artifactLifecycle')
      const result = await runD1EvidenceScrub(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 250, 1000),
      })
      if (result.failed || result.blocked) throw new Error(`d1 evidence scrub failed ${JSON.stringify(result)}`)
      return `d1_evidence_scrub candidates=${result.candidates} scrubbed=${result.scrubbed}`
    },
    'r2-retention-sweep': async () => {
      const { runR2RetentionSweep } = await import('./artifactLifecycle')
      const result = await runR2RetentionSweep(c.env, {
        limit: parseBoundedPositiveInt(c.req.query('limit'), 250, 1000),
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
    'storage-health-gate': async () => {
      const { runStorageHealthGate } = await import('./artifactLifecycle')
      const result = await runStorageHealthGate(c.env)
      if (!result.healthy) throw new Error(`storage health gate failed ${JSON.stringify(result)}`)
      return `storage_health_gate ${JSON.stringify(result)}`
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
      const { runStorageHealthGate } = await import('./artifactLifecycle')
      const health = await runStorageHealthGate(c.env)
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
}
