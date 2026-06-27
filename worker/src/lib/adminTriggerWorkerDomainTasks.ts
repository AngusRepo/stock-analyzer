import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'
import { runVerifyV2 } from './controllerWorkflows'
import { twToday } from './dateUtils'
import { runMorningWarmup, runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'

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
    SELECT run_id, final_count, emerging_count
      FROM screener_funnel_runs
     WHERE date = ?
       AND status = 'success'
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(triggerTime).first() as { run_id?: string; final_count?: number; emerging_count?: number } | null

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

export function buildAdminWorkerDomainTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  const requestedRunDate = () => c.req.query('date') || undefined

  return {
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
      const debate = await reconcilePendingBuyDebates(c.env, twToday())
      const snapshot = await loadPendingBuySnapshot(c.env, twToday(), { allowFallbackRecent: false })
      const state = buildPendingBuyStateSummary(snapshot.pendingBuys, snapshot.meta)
      return formatPendingBuyCronSummary(warmup, state, { debate })
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
      await runWeeklyCleanup(c.env)
      await deps.runWeeklyLifecycleCheck().catch((e) => { console.warn('[Lifecycle] failed:', e) })
      await runWeeklyLocalMaintenance(c.env)
      return 'weekly cleanup done: local maintenance + lifecycle dry-run; retrain is monthly/manual only'
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
