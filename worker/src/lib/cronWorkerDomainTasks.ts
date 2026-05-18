import type { Bindings } from '../types'
import { runMorningWarmup, runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'
import { runDailySnapshot } from './paperWorkerTasks'
import { runEODExit } from './paperExitTasks'
import { runWeeklyLifecycleCheck } from './controllerWorkflows'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { reconcilePendingBuyDebates, setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { formatPendingBuyCronSummary } from './pendingBuyCronSummary'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'

interface WorkerCronDeps {
  cron: string
  env: Bindings
  ctx: ExecutionContext
  twTodayStr: string
  runWithLog: (task: string, fn: () => Promise<string>) => void
  runPreMarketWarmup: (env: Bindings) => Promise<string>
  settlePaperT2: (env: Bindings) => Promise<void>
  runIntradayHeartbeat: (env: Bindings, ctx: ExecutionContext, twTodayStr: string) => Promise<void>
  runIntradayRescore: (env: Bindings, cron: string, twTodayStr: string) => Promise<string>
}

export async function handleWorkerDomainCron(deps: WorkerCronDeps): Promise<boolean> {
  const { cron, env, ctx, twTodayStr, runWithLog, runPreMarketWarmup, settlePaperT2, runIntradayHeartbeat, runIntradayRescore } = deps

  if (cron === '50 0 * * 1-5') {
    runWithLog('pre-market-warmup', async () => {
      const warmup = await runPreMarketWarmup(env)
      const debate = await reconcilePendingBuyDebates(env, twTodayStr)
      const snapshot = await loadPendingBuySnapshot(env, twTodayStr, { allowFallbackRecent: false })
      const state = buildPendingBuyStateSummary(snapshot.pendingBuys, snapshot.meta)
      return formatPendingBuyCronSummary(warmup, state, { debate })
    })
    return true
  }

  if (cron === '15 23 * * SUN-THU') {
    runWithLog('morning-setup', async () => {
      await settlePaperT2(env)
      await runMorningWarmup(env)
      await setupMorningPendingBuys(env)
      const snapshot = await loadPendingBuySnapshot(env, twTodayStr, { allowFallbackRecent: false })
      const state = buildPendingBuyStateSummary(snapshot.pendingBuys, snapshot.meta)
      return formatPendingBuyCronSummary('morning setup done', state, { source: snapshot.source })
    })
    return true
  }

  if (cron === '15 9 * * 1-5') {
    runWithLog('evening-chain', async () => 'SKIP: legacy Cloudflare 17:15 cron disabled; GCP Scheduler owns TW 17:30 evening-chain')
    return true
  }

  if (cron === '30 9 * * 1-5') {
    runWithLog('pipeline', async () => 'SKIP: legacy direct pipeline cron disabled; GCP Scheduler must trigger evening-chain root')
    return true
  }

  if (cron === '20 10 * * 1-5') {
    runWithLog('adapt', async () => {
      const { runAdaptiveUpdate } = await import('./adaptiveEngine')
      return runAdaptiveUpdate(env)
    })
    return true
  }

  if (cron === '0 19 * * *') {
    runWithLog('debate-memory-retention', async () => {
      const res = await env.DB.prepare(
        `DELETE FROM debate_memory WHERE debate_date < DATE('now', '-180 days')`,
      ).run()
      const meta = (res as any)?.meta ?? {}
      return `deleted=${meta.changes ?? 0}`
    })
    return true
  }

  if (cron === '25 5 * * 1-5') {
    runWithLog('eod-exit', async () => {
      await runEODExit(env)
      return 'EOD exit done'
    })
    return true
  }

  if (cron === '20 6 * * 1-5') {
    runWithLog('daily-snapshot', async () => {
      await runDailySnapshot(env)
      return 'Daily snapshot done'
    })
    return true
  }

  if (['* 1-5 * * 1-5', '* 1-4 * * 1-5', '0-30 5 * * 1-5'].includes(cron)) {
    await runIntradayHeartbeat(env, ctx, twTodayStr)
    return true
  }

  if (['0 2 * * 1-5', '0 3 * * 1-5', '0 4 * * 1-5', '30 4 * * 1-5'].includes(cron)) {
    runWithLog('intraday-rescore', async () => runIntradayRescore(env, cron, twTodayStr))
    return true
  }

  if (cron === '30 22 * * SUN-THU') {
    runWithLog('us-leading', async () => {
      const { fetchAndStoreUSLeading } = await import('./usLeading')
      const signal = await fetchAndStoreUSLeading(env)
      return signal ? `SOX ${((signal.sox_return ?? 0) * 100).toFixed(1)}% | ${signal.sentiment}` : 'us-leading failed'
    })
    return true
  }

  if (cron === '45 22 * * SUN-THU') {
    runWithLog('news-analyst', async () => {
      const { runDailyNewsAnalysis } = await import('./newsAnalyst')
      const report = await runDailyNewsAnalysis(env as any)
      return `bias=${report.bias} conf=${report.confidence.toFixed(2)} factors=${report.key_factors.length}`
    })
    return true
  }

  if (cron === '50 23 * * SUN-THU') {
    runWithLog('morning-briefing', async () => {
      const { generateMorningBriefing } = await import('./morningBriefing')
      return generateMorningBriefing(env)
    })
    return true
  }

  if (cron === '25 10 * * 1-5') {
    runWithLog('daily-report', async () => {
      const { generateDailyReport } = await import('./dailyReport')
      const reportSummary = await generateDailyReport(env)
      let triggers = 'skip'
      try {
        const { getTradingConfig } = await import('./tradingConfig')
        const cfg = await getTradingConfig(env.KV)
        const { checkRollingSharpe, checkDailyDrawdown } = await import('./riskTriggers')
        const sharpeTh = (cfg as any)?.risk?.sharpe_rolling_threshold ?? 0.5
        const ddTh = (cfg as any)?.risk?.dd_spike_threshold ?? 0.08
        const [sharpe, drawdown] = await Promise.all([
          checkRollingSharpe(env, sharpeTh),
          checkDailyDrawdown(env, ddTh),
        ])
        triggers = `sharpe:${sharpe} | dd:${drawdown}`
      } catch (e: any) {
        triggers = `hook_error(${String(e?.message ?? e).slice(0, 40)})`
      }
      return `${reportSummary} | triggers[${triggers}]`
    })
    return true
  }

  if (cron === '0 20 * * 6') {
    runWithLog('weekly-cleanup', async () => {
      await runWeeklyCleanup(env)
      await runWeeklyLifecycleCheck(env).catch((e) => { console.warn('[Lifecycle] failed:', e) })
      await runWeeklyLocalMaintenance(env)
      return 'weekly cleanup done: local maintenance + lifecycle dry-run; retrain is monthly/manual only'
    })
    return true
  }

  if (cron === '30 22 * * 6') {
    runWithLog('sector-leaders', async () => {
      const { computeSectorLeaders } = await import('./sectorCorrelation')
      const result = await computeSectorLeaders(env.DB)
      return `sectors=${result.sectorCount} leaders=${result.leaderCount}`
    })
    return true
  }

  return false
}
