import type { Bindings } from '../types'
import {
  runModelIcTrackerChain,
  runObsidianDaily,
  runRegimeCompute,
  runVerifyV2,
  runWeeklyAudit,
  runWeeklyBacktest,
  runWeeklyAlphaQuality,
  runWeeklyMonteCarlo,
  runWeeklyPBO,
  runWeeklyOptunaResearch,
  runOptunaQueueProcessor,
} from './controllerWorkflows'
import { twToday } from './dateUtils'

interface GcpCronDeps {
  cron: string
  env: Bindings
  runWithLog: (task: string, fn: () => Promise<string>) => void
}

export async function handleGcpDomainCron(deps: GcpCronDeps): Promise<boolean> {
  const { cron, env, runWithLog } = deps

  if (cron === '50 10 * * 1-5') {
    runWithLog('regime-compute', async () => runRegimeCompute(env))
    return true
  }

  if (cron === '30 11 * * 5') {
    runWithLog('model-ic-tracker', async () => runModelIcTrackerChain(env))
    return true
  }

  if (cron === '0 11 * * 1-5') {
    runWithLog('verify-v2', async () => {
      const verify = await runVerifyV2(env)
      return `${verify} | rolling_ic after verify callback`
    })
    return true
  }

  if (cron === '40 10 * * 1-5') {
    runWithLog('obsidian-daily', async () => {
      const json = await runObsidianDaily(env, twToday())
      return typeof json === 'string' ? json : JSON.stringify(json).slice(0, 300)
    })
    return true
  }

  if (cron === '30 10 * * 5') {
    runWithLog('weekly-audit', async () => runWeeklyAudit(env))
    return true
  }

  if (cron === '0 22 * * 6') {
    runWithLog('weekly-backtest', async () => {
      const bt = await runWeeklyBacktest(env)
      const mc = await runWeeklyMonteCarlo(env).catch((e) => { console.warn('[MC]', e); return 'failed' })
      const pbo = await runWeeklyPBO(env).catch((e) => { console.warn('[PBO]', e); return 'failed' })
      return `bt(${bt}) | mc(${mc}) | pbo(${pbo})`
    })
    runWithLog('alpha-quality', async () => runWeeklyAlphaQuality(env))
    return true
  }

  if (cron === '30 22 * * 6') {
    runWithLog('weekly-optuna', async () => runWeeklyOptunaResearch(env))
    return true
  }

  if (cron === '0 */6 * * *') {
    runWithLog('optuna-queue', async () => runOptunaQueueProcessor(env))
    return true
  }

  return false
}
