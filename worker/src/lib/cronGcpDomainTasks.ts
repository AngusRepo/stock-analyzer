import type { Bindings } from '../types'
import {
  runModelIcFullCheck,
  runObsidianDaily,
  runRegimeCompute,
  runVerifyV2,
  runWeeklyAudit,
  runWeeklyAlphaQuality,
  runWeeklyOptunaResearch,
  runWeeklyValidationChain,
  runOptunaQueueProcessor,
  runExternalEvidenceMaterialize,
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
    runWithLog('model-ic-full-check', async () => runModelIcFullCheck(env))
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
    runWithLog('obsidian-sync', async () => {
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
    runWithLog('weekly-backtest', async () => runWeeklyValidationChain(env, twToday()))
    runWithLog('alpha-quality', async () => runWeeklyAlphaQuality(env))
    return true
  }

  if (cron === '30 22 * * 6') {
    runWithLog('weekly-optuna', async () => runWeeklyOptunaResearch(env))
    return true
  }

  if (cron === '45 22 * * 6') {
    runWithLog('s12-smcvwap-calibration', async () => {
      const runDate = twToday()
      const runId = 's12-smcvwap-calibration-' + runDate + '-' + Date.now()
      await env.UPDATE_QUEUE.send({
        type: 'scheduled_admin_task',
        scheduledTask: 's12-smcvwap-calibration',
        cursor: 0,
        triggerTime: runDate,
        runId,
      })
      return 'triggered s12-smcvwap-calibration run_date=' + runDate + ' run_id=' + runId + ' callback expected'
    })
    return true
  }

  if (cron === '0 */6 * * *') {
    runWithLog('optuna-queue', async () => runOptunaQueueProcessor(env))
    return true
  }

  if (cron === '15 15 * * 1-5') {
    runWithLog('external-evidence', async () => runExternalEvidenceMaterialize(env, twToday()))
    return true
  }

  return false
}
