/**
 * schedulerStatus.ts - Scheduler dashboard status builder
 */

import type { Bindings } from '../types'
import { getCronLogs, type CronLogEntry } from './cronLogger'

interface JobDef {
  id: string
  name: string
  schedule: string
  cron: string
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'monthly' | 'daily'
  chainIndex?: number
}

const JOB_DEFS: JobDef[] = [
  { id: 'pre-market-warmup', name: 'Pre-market Warmup', schedule: 'Weekdays 08:50', cron: '50 0 * * 1-5', group: 'pipeline_chain', chainIndex: 0 },
  { id: 'ml-warmup', name: 'ML Warmup', schedule: 'Weekdays 17:15', cron: '15 9 * * 1-5', group: 'pipeline_chain', chainIndex: 1 },
  { id: 'pipeline', name: 'Pipeline', schedule: 'Weekdays 17:30', cron: '30 9 * * 1-5', group: 'pipeline_chain', chainIndex: 2 },
  { id: 'ml-predict', name: 'ML Predict', schedule: 'After pipeline', cron: '', group: 'pipeline_chain', chainIndex: 3 },
  { id: 'recommendation', name: 'Daily Recommendation', schedule: 'After ML predict', cron: '', group: 'pipeline_chain', chainIndex: 4 },

  { id: 'us-leading', name: 'US Leading', schedule: 'Mon-Fri 06:30', cron: '30 22 * * SUN-THU', group: 'daily' },
  { id: 'news-analyst', name: 'News Analyst', schedule: 'Mon-Fri 06:45', cron: '45 22 * * SUN-THU', group: 'daily' },
  { id: 'morning-setup', name: 'Morning Setup / Debate', schedule: 'Mon-Fri 07:15', cron: '15 23 * * SUN-THU', group: 'daily' },
  { id: 'morning-briefing', name: 'Morning Briefing', schedule: 'Mon-Fri 07:50', cron: '50 23 * * SUN-THU', group: 'daily' },
  { id: 'daily-snapshot', name: 'Daily Snapshot', schedule: 'Weekdays 14:20', cron: '20 6 * * 1-5', group: 'daily' },
  { id: 'adapt', name: 'Adapt Params', schedule: 'Weekdays 18:20', cron: '20 10 * * 1-5', group: 'daily' },
  { id: 'daily-report', name: 'Daily Report', schedule: 'Weekdays 18:25', cron: '25 10 * * 1-5', group: 'daily' },
  { id: 'obsidian-daily', name: 'Obsidian Sync', schedule: 'Weekdays 18:40', cron: '40 10 * * 1-5', group: 'daily' },
  { id: 'regime-compute', name: 'HMM Regime', schedule: 'Weekdays 18:50', cron: '50 10 * * 1-5', group: 'daily' },
  { id: 'verify-v2', name: 'Verify (V2 LangGraph)', schedule: 'Weekdays 19:00', cron: '0 11 * * 1-5', group: 'daily' },
  { id: 'debate-memory-retention', name: 'Debate Memory Retention', schedule: 'Daily 03:00', cron: '0 19 * * *', group: 'daily' },

  { id: 'intraday-check', name: 'Intraday Check', schedule: 'Mon-Fri 09-13h per-min', cron: '* 1-5 * * 1-5', group: 'intraday' },
  { id: 'intraday-rescore', name: 'Intraday Re-score (10/11/12/12:30)', schedule: '10:00 / 11:00 / 12:00 / 12:30', cron: '0 2,3,4 * * 1-5 + 30 4 * * 1-5', group: 'intraday' },
  { id: 'eod-exit', name: 'EOD Exit', schedule: 'Weekdays 13:25', cron: '25 5 * * 1-5', group: 'intraday' },

  { id: 'weekly-audit', name: 'Weekly Audit', schedule: 'Friday 18:30', cron: '30 10 * * 5', group: 'weekly' },
  { id: 'model-ic-tracker', name: 'Model IC Tracker', schedule: 'Friday 19:30', cron: '30 11 * * 5', group: 'weekly' },
  { id: 'weekly-cleanup', name: 'Weekly Cleanup', schedule: 'Sunday 04:00', cron: '0 20 * * 6', group: 'weekly' },
  { id: 'weekly-backtest', name: 'Weekly Backtest/MC', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'alpha-quality', name: 'Alpha Quality', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'weekly-optuna', name: 'Weekly Optuna', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },

  { id: 'optuna-queue', name: 'Optuna Queue Processor', schedule: 'Every 6h', cron: '0 */6 * * *', group: 'daily' },
]

const DAG_STEPS = ['Bulk Fetch', 'Screener', 'ML Predict', 'Recommend', 'LLM Reason', 'Write D1']
const DOW_NAME_TO_NUM: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}
const PIPELINE_CHILD_TASKS = new Set(['ml-predict', 'recommendation'])

function formatDuration(durationMs?: number | null): string {
  if (durationMs == null) return 'N/A'
  if (durationMs < 1000) return '<1s'
  if (durationMs >= 60000) {
    return `${Math.floor(durationMs / 60000)}m${Math.floor((durationMs % 60000) / 1000)}s`
  }
  if (durationMs < 10000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.floor(durationMs / 1000)}s`
}

function getLast7Dates(): string[] {
  const dates: string[] = []
  const now = new Date(Date.now() + 8 * 3600_000)
  for (let i = 0; i < 10 && dates.length < 7; i += 1) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dow = d.getDay()
    if (dow >= 1 && dow <= 5) dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

function parseDowValue(token: string): number | null {
  const upper = token.trim().toUpperCase()
  if (upper in DOW_NAME_TO_NUM) return DOW_NAME_TO_NUM[upper]
  const num = Number.parseInt(upper, 10)
  return Number.isFinite(num) ? num : null
}

function expandRange(rangeExpr: string): number[] {
  const [startToken, endToken] = rangeExpr.split('-')
  const start = parseDowValue(startToken)
  const end = parseDowValue(endToken)
  if (start == null || end == null) return []

  const out: number[] = []
  if (start <= end) {
    for (let i = start; i <= end; i += 1) out.push(i)
  } else {
    for (let i = start; i <= 6; i += 1) out.push(i)
    for (let i = 0; i <= end; i += 1) out.push(i)
  }
  return out
}

function parseDowExpr(expr: string): number[] {
  return expr
    .split(',')
    .flatMap((part) => part.includes('-') ? expandRange(part) : [parseDowValue(part)])
    .filter((value): value is number => value != null)
}

function parseLogTime(ts?: string): number | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

function getDisplayLog(logs: CronLogEntry[] | undefined, taskId: string): CronLogEntry | undefined {
  const log = logs?.find((entry) => entry.task === taskId)
  if (!log) return undefined
  if (!PIPELINE_CHILD_TASKS.has(taskId)) return log

  const pipelineLog = logs?.find((entry) => entry.task === 'pipeline')
  const logTime = parseLogTime(log.timestamp)
  const pipelineTime = parseLogTime(pipelineLog?.timestamp)

  if (pipelineTime == null || logTime == null) return undefined
  if (logTime < pipelineTime) return undefined
  return log
}

function inferPipelineChildLog(logs: CronLogEntry[] | undefined, taskId: string): CronLogEntry | undefined {
  if (!PIPELINE_CHILD_TASKS.has(taskId)) return undefined

  const pipelineLog = logs?.find((entry) => entry.task === 'pipeline')
  if (!pipelineLog || pipelineLog.status === 'skipped') return undefined

  const summary = pipelineLog.summary ?? ''

  if (taskId === 'ml-predict') {
    const predictionMatch =
      summary.match(/ml-predict(?:-v2)?\((\d+)\s+predictions\)/i) ??
      summary.match(/predictions(?:_written)?[=:](\d+)/i)

    return {
      ...pipelineLog,
      task: taskId,
      summary: predictionMatch
        ? `derived from pipeline: ${predictionMatch[1]} predictions`
        : `derived from pipeline: ${pipelineLog.status}`,
      error: pipelineLog.status === 'error' ? (pipelineLog.error ?? pipelineLog.summary) : undefined,
    }
  }

  if (taskId === 'recommendation') {
    const recommendationDetected =
      summary.includes('recommendation') ||
      /recommendations?_updated[=:](\d+)/i.test(summary) ||
      /recos[=:](\d+)/i.test(summary)

    if (!recommendationDetected && pipelineLog.status === 'success') return undefined

    return {
      ...pipelineLog,
      task: taskId,
      summary: `derived from pipeline: ${pipelineLog.status}`,
      error: pipelineLog.status === 'error' ? (pipelineLog.error ?? pipelineLog.summary) : undefined,
    }
  }

  return undefined
}

function getNextRunApprox(cron: string): string {
  if (!cron) return 'N/A'
  const parts = cron.split(' ')
  if (parts.length < 5) return 'N/A'

  const [min, hour, , , dow] = parts
  const targetHourUtc = Number.parseInt(hour, 10)
  const targetMin = Number.parseInt(min, 10)
  if (!Number.isFinite(targetHourUtc) || !Number.isFinite(targetMin)) return 'N/A'

  const now = new Date(Date.now() + 8 * 3600_000)
  const targetHourTW = targetHourUtc + 8

  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(targetHourTW, targetMin, 0, 0)
    if (candidate <= now) continue

    if (dow === '*') {
      return `${candidate.getMonth() + 1}/${candidate.getDate()} ${String(targetHourTW % 24).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`
    }

    const allowedDays = parseDowExpr(dow)
    if (allowedDays.includes(candidate.getDay())) {
      return `${candidate.getMonth() + 1}/${candidate.getDate()} ${String(targetHourTW % 24).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`
    }
  }

  return 'N/A'
}

function formatTimestamp(ts: string): string {
  if (!ts) return 'N/A'
  try {
    const d = new Date(ts)
    d.setHours(d.getHours() + 8)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return ts
  }
}

export async function getSchedulerStatus(env: Bindings) {
  const dates = getLast7Dates()
  const today = dates[0]

  const allLogs: Record<string, CronLogEntry[]> = {}
  await Promise.all(
    dates.map(async (date) => {
      allLogs[date] = await getCronLogs(env.KV, date)
    }),
  )

  const jobs = JOB_DEFS.map((def) => {
    const todayLog = getDisplayLog(allLogs[today], def.id) ?? inferPipelineChildLog(allLogs[today], def.id)

    let lastLog: CronLogEntry | undefined
    for (const date of dates) {
      const log = getDisplayLog(allLogs[date], def.id) ?? inferPipelineChildLog(allLogs[date], def.id)
      if (log?.status === 'skipped') continue
      if (log) {
        lastLog = log
        break
      }
    }

    const history7d = dates.map((date) => {
      const log = getDisplayLog(allLogs[date], def.id) ?? inferPipelineChildLog(allLogs[date], def.id)
      if (!log || log.status === 'skipped' || log.status === 'triggered' || log.status === 'running') return 'skip'
      return log.status === 'success' ? 'success' : 'failed'
    }).reverse()

    const lastStatus = lastLog?.status === 'success'
      ? 'success' as const
      : lastLog?.status === 'error'
        ? 'failed' as const
        : lastLog?.status === 'triggered' || lastLog?.status === 'running'
          ? 'running' as const
          : 'skip' as const

    const lastDuration = formatDuration(lastLog?.duration_ms)

    const successCount = history7d.filter((item) => item === 'success').length
    const totalCount = history7d.filter((item) => item !== 'skip').length

    return {
      id: def.id,
      name: def.name,
      schedule: def.schedule,
      cron: def.cron,
      group: def.group,
      chainIndex: def.chainIndex,
      lastRun: lastLog?.timestamp ? formatTimestamp(lastLog.timestamp) : 'N/A',
      lastStatus,
      lastDuration,
      lastError: todayLog?.error ?? lastLog?.error,
      nextRun: getNextRunApprox(def.cron),
      history7d,
      rate7d: totalCount > 0 ? `${successCount}/${totalCount}` : 'N/A',
      summary: lastLog?.summary || '',
    }
  })

  const failed24h = jobs.filter((job) => {
    const todayLog = getDisplayLog(allLogs[today], job.id) ?? inferPipelineChildLog(allLogs[today], job.id)
    return todayLog?.status === 'error'
  }).length

  const allRuns = jobs.flatMap((job) => job.history7d.filter((item) => item !== 'skip'))
  const successRate = allRuns.length > 0
    ? Math.round((allRuns.filter((item) => item === 'success').length / allRuns.length) * 1000) / 10
    : 100

  const nextJob = jobs
    .filter((job) => job.nextRun !== 'N/A')
    .sort((a, b) => a.nextRun.localeCompare(b.nextRun))[0]

  let dagSteps = DAG_STEPS.map((name) => ({ name, duration: 'N/A', status: 'skip' as string }))
  try {
    const pipelineLog = allLogs[today]?.find((entry) => entry.task === 'pipeline' && entry.status === 'success')
    if (pipelineLog?.details) {
      dagSteps = DAG_STEPS.map((name) => {
        const detail = pipelineLog.details?.find((row) => row.includes(name))
        return {
          name,
          duration: detail?.match(/(\d+[ms]+\d*[s]*)/)?.[1] || 'N/A',
          status: detail?.toLowerCase().includes('error') ? 'failed' : 'success',
        }
      })
    }
  } catch {
    dagSteps = DAG_STEPS.map((name) => ({ name, duration: 'N/A', status: 'skip' as string }))
  }

  const heatmapJobs = ['pipeline', 'ml-predict', 'intraday-rescore', 'morning-setup', 'us-leading', 'weekly-cleanup', 'weekly-audit', 'obsidian-daily']
  const heatmap = heatmapJobs.map((jobId) => {
    const job = jobs.find((row) => row.id === jobId)
    return {
      name: job?.name || jobId,
      cells: dates.map((date) => {
        const log = getDisplayLog(allLogs[date], jobId) ?? inferPipelineChildLog(allLogs[date], jobId)
        if (!log || log.status === 'skipped' || log.status === 'triggered' || log.status === 'running') return 'skip'
        return log.status === 'success' ? 'success' : 'failed'
      }).reverse(),
    }
  })

  return {
    stats: {
      total: JOB_DEFS.length,
      active: JOB_DEFS.length,
      failed24h,
      successRate7d: successRate,
      nextJob: nextJob?.name || 'N/A',
      nextIn: nextJob?.nextRun || 'N/A',
    },
    jobs,
    dag: {
      lastRun: allLogs[today]?.find((entry) => entry.task === 'pipeline')?.timestamp || 'N/A',
      totalDuration: allLogs[today]?.find((entry) => entry.task === 'pipeline')?.duration_ms || 0,
      steps: dagSteps,
    },
    heatmap,
    dates: dates.reverse(),
  }
}
