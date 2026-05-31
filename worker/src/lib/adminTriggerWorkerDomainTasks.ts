import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'
import { controllerPostJson } from './controllerClient'
import { runVerifyV2 } from './controllerWorkflows'
import { twToday } from './dateUtils'
import { runMorningWarmup, runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'

const RESCORE_CRONS = new Set(['0 2 * * 1-5', '0 3 * * 1-5', '0 4 * * 1-5', '30 4 * * 1-5'])

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

async function runMlControllerWarmup(env: any): Promise<string> {
  if (!env.ML_CONTROLLER_URL) return 'SKIP: ML_CONTROLLER_URL not set'
  const headers: Record<string, string> = {}
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
  const res = await fetch(`${env.ML_CONTROLLER_URL}/health`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)
  if (!res?.ok) return `ML Controller health failed${res ? ` (${res.status})` : ''}`
  const health = await res.json().catch(() => ({})) as any
  return [
    'ML Controller ok',
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
  policyId: 'NeuralUCB' | 'NeuralTS',
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

async function runFinLabAiSkillDiscoveryTask(c: any, runDate?: string): Promise<string> {
  const { runFinLabAiSkillDiscoveryClosure } = await import('./finlabAiSkillDiscovery')
  let rawFactorMinerPayload: any = null
  let rawFactorSummary = 'raw_factor_miner=skipped_no_ml_controller_url'
  if (c.env.ML_CONTROLLER_URL) {
    try {
      rawFactorMinerPayload = await controllerPostJson<any>(
        c.env,
        '/finlab/ai-factor-discovery',
        { max_per_lane: 8, dry_run: false },
        120_000,
      )
      rawFactorSummary = `raw_factor_miner=ok candidates=${Array.isArray(rawFactorMinerPayload?.candidates) ? rawFactorMinerPayload.candidates.length : 0}`
    } catch (error) {
      rawFactorSummary = `raw_factor_miner=unavailable:${String(error).slice(0, 160)}`
    }
  }
  const report = await runFinLabAiSkillDiscoveryClosure(c.env, runDate ?? twToday(), {
    dryRun: false,
    rawFactorMinerPayload,
  })
  return [
    `status=${report.status}`,
    `source_rows=${report.source_rows}`,
    `packets=${report.packets.length}`,
    `research_experiments=${report.persisted.research_experiments}`,
    `strategy_specs=${report.persisted.strategy_specs}`,
    `invalid=${report.skipped_invalid.length}`,
    rawFactorSummary,
    report.reason ? `reason=${report.reason}` : '',
  ].filter(Boolean).join(' ')
}

async function runStrategyLearningTask(c: any, runDate?: string): Promise<string> {
  const { runStrategyLearningClosure } = await import('./strategyLearning')
  return runStrategyLearningClosure(c.env.DB, runDate ?? twToday())
}

async function runPostVerifyChainTask(c: any, runDate?: string): Promise<string> {
  const { runPostVerifyCallbackChain } = await import('./postMarketChain')
  const date = runDate ?? twToday()
  await runPostVerifyCallbackChain(c.env, {
    runDate: date,
    upstreamRunId: c.req.query('run_id') || `manual-post-verify-${date}`,
    metadata: {
      allow_historical_learning_catchup: c.req.query('learning_catchup') !== '0',
      source: 'admin_trigger_post_verify_chain',
    },
  })
  return `post_verify_chain=completed run_date=${date} learning_catchup=${c.req.query('learning_catchup') !== '0'}`
}

export function buildAdminWorkerDomainTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  const requestedRunDate = () => c.req.query('date') || undefined

  return {
    'evening-chain': () => deps.runDailyUpdate(!!c.req.query('force'), requestedRunDate()),
    'finlab-ai-skill-discovery': () => runFinLabAiSkillDiscoveryTask(c, requestedRunDate()),
    'strategy-learning': () => runStrategyLearningTask(c, requestedRunDate()),
    'post-verify-chain': () => runPostVerifyChainTask(c, requestedRunDate()),
    screener: () => deps.runMarketScreener(requestedRunDate()),
    update: () => deps.runDailyUpdate(!!c.req.query('force'), requestedRunDate()),
    ml: () => deps.runMLAndRiskV2(requestedRunDate()),
    recommendation: () => deps.runDailyRecommendation(requestedRunDate()),
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
  }
}
