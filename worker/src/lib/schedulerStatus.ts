/**
 * schedulerStatus.ts - Scheduler dashboard status builder
 */

import type { Bindings } from '../types'
import { getCronLogs, getSchedulerLogTaskCount, type CronLogEntry } from './schedulerRunLogger'
import { getNextRunApproxWithPolicy } from './schedulerPolicy'
import { getSchedulerDependencySpec } from './schedulerDependencyMap'

interface JobDef {
  id: string
  name: string
  schedule: string
  cron: string
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'monthly' | 'daily'
  chainIndex?: number
}

type SchedulerLastStatus = 'success' | 'failed' | 'running' | 'skip' | 'waiting' | 'sleep'
type SchedulerResolvedStatus = {
  status: SchedulerLastStatus | null
  staleRunning: boolean
  staleReason?: string
}
type SchedulerDurationConcern = 'expected_short' | 'suspicious_short' | null

const JOB_DEFS: JobDef[] = [
  { id: 'pre-market-warmup', name: 'Pre-market Warmup', schedule: 'Weekdays 08:50', cron: '50 0 * * 1-5', group: 'pipeline_chain', chainIndex: 0 },
  { id: 'market-close-refresh', name: 'Market Close Refresh', schedule: 'Weekdays 18:10', cron: '10 10 * * 1-5', group: 'pipeline_chain', chainIndex: 1 },
  { id: 'source-readiness-probe', name: 'Source Readiness Probe', schedule: 'Weekdays 18:30-21:50 / 20m', cron: '30,50 10 * * 1-5 + 10,30,50 11-13 * * 1-5', group: 'pipeline_chain', chainIndex: 2 },
  { id: 'evening-chain', name: 'Evening Chain Fallback', schedule: 'Weekdays 22:00 fallback', cron: '0 14 * * 1-5', group: 'pipeline_chain', chainIndex: 3 },
  { id: 'finlab-v4-backfill', name: 'FinLab V4 Backfill', schedule: 'Inside readiness/evening chain', cron: '', group: 'pipeline_chain', chainIndex: 4 },
  { id: 'update', name: 'Market Data Update', schedule: 'After FinLab canonical ready', cron: '', group: 'pipeline_chain', chainIndex: 5 },
  { id: 'indicator-queue', name: 'Indicator Queue', schedule: 'After update readiness', cron: '', group: 'pipeline_chain', chainIndex: 6 },
  { id: 'screener', name: 'Screener', schedule: 'After indicators', cron: '', group: 'pipeline_chain', chainIndex: 7 },
  { id: 'regime-compute', name: 'HMM Regime', schedule: 'Before pipeline recommendation', cron: '', group: 'pipeline_chain', chainIndex: 8 },
  { id: 'pipeline', name: 'Pipeline', schedule: 'After screener + regime', cron: '', group: 'pipeline_chain', chainIndex: 9 },
  { id: 'ml-predict', name: 'ML Predict', schedule: 'Inside pipeline', cron: '', group: 'pipeline_chain', chainIndex: 10 },
  { id: 'recommendation', name: 'Daily Recommendation', schedule: 'Inside pipeline', cron: '', group: 'pipeline_chain', chainIndex: 11 },
  { id: 'post-pipeline-chain', name: 'Post Pipeline Callback', schedule: 'After pipeline callback', cron: '', group: 'pipeline_chain', chainIndex: 12 },
  { id: 'verify-v2', name: 'Verify (V2 LangGraph)', schedule: 'After pipeline callback', cron: '', group: 'pipeline_chain', chainIndex: 13 },
  { id: 'post-verify-chain', name: 'Post Verify Callback', schedule: 'After verify callback', cron: '', group: 'pipeline_chain', chainIndex: 14 },
  { id: 'model-ic-tracker', name: 'Model IC Tracker', schedule: 'After verify callback / Friday full check', cron: '30 11 * * 5', group: 'pipeline_chain', chainIndex: 15 },
  { id: 'linucb-reward-ledger', name: 'LinUCB Reward Ledger', schedule: 'After rolling IC', cron: '', group: 'pipeline_chain', chainIndex: 16 },
  { id: 'adapt', name: 'Adapt Params', schedule: 'After LinUCB ledger', cron: '', group: 'pipeline_chain', chainIndex: 17 },
  { id: 'daily-report', name: 'Daily Report', schedule: 'After adapt', cron: '', group: 'pipeline_chain', chainIndex: 18 },
  { id: 'paper-active-postmarket', name: 'Paper Active Postmarket', schedule: 'After daily report', cron: '', group: 'pipeline_chain', chainIndex: 19 },
  { id: 'obsidian-sync', name: 'Obsidian Sync', schedule: 'After paper-active postmarket', cron: '', group: 'pipeline_chain', chainIndex: 20 },
  { id: 'meta-learning-shadow', name: 'Meta Learning Shadow', schedule: 'After obsidian sync', cron: '', group: 'pipeline_chain', chainIndex: 21 },
  { id: 'strategy-learning', name: 'Strategy Learning', schedule: 'After meta shadow / historical reruns', cron: '', group: 'pipeline_chain', chainIndex: 22 },

  { id: 'us-leading', name: 'US Leading', schedule: 'Mon-Fri 06:30', cron: '30 22 * * SUN-THU', group: 'daily' },
  { id: 'news-analyst', name: 'News Analyst', schedule: 'Mon-Fri 06:45', cron: '45 22 * * SUN-THU', group: 'daily' },
  { id: 'morning-setup', name: 'Morning Setup / Debate', schedule: 'Mon-Fri 07:15', cron: '15 23 * * SUN-THU', group: 'daily' },
  { id: 'morning-briefing', name: 'Morning Briefing', schedule: 'Mon-Fri 07:50', cron: '50 23 * * SUN-THU', group: 'daily' },
  { id: 'daily-snapshot', name: 'Daily Snapshot', schedule: 'Weekdays 14:20', cron: '20 6 * * 1-5', group: 'daily' },
  { id: 'external-evidence', name: 'External Evidence', schedule: 'Weekdays 23:15', cron: '15 15 * * 1-5', group: 'daily' },
  { id: 'debate-memory-retention', name: 'Debate Memory Retention', schedule: 'Daily 03:00', cron: '0 19 * * *', group: 'daily' },
  { id: 'audit-json-retention', name: 'Audit JSON Retention', schedule: 'Sunday 03:30', cron: '30 19 * * 6', group: 'weekly' },

  { id: 'intraday-check', name: 'Intraday Check', schedule: 'Mon-Fri 09:00-13:30 per-min', cron: '* 1-4 * * 1-5 + 0-30 5 * * 1-5', group: 'intraday' },
  { id: 'intraday-rescore', name: 'Intraday Re-score (10/11/12/12:30)', schedule: '10:00 / 11:00 / 12:00 / 12:30', cron: '0 2,3,4 * * 1-5 + 30 4 * * 1-5', group: 'intraday' },
  { id: 'eod-exit', name: 'EOD Exit', schedule: 'Weekdays 13:25', cron: '25 5 * * 1-5', group: 'intraday' },
  { id: 'post-close-price-refresh', name: 'Post-close Price Refresh', schedule: 'Weekdays 13:40', cron: '40 5 * * 1-5', group: 'intraday' },

  { id: 'weekly-audit', name: 'Weekly Audit', schedule: 'Friday 18:30', cron: '30 10 * * 5', group: 'weekly' },
  { id: 'weekly-cleanup', name: 'Weekly Cleanup', schedule: 'Sunday 04:00 (no retrain)', cron: '0 20 * * 6', group: 'weekly' },
  { id: 'weekly-backtest', name: 'Weekly Validation/MC', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'alpha-quality', name: 'Alpha Quality', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'weekly-optuna', name: 'Weekly Optuna', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },
  { id: 'adaptive-meta-policy-replay', name: 'Adaptive Meta Policy Replay', schedule: 'Sunday 06:40', cron: '40 22 * * 6', group: 'weekly' },
  { id: 'linucb-multiplier-replay', name: 'LinUCB Multiplier Replay', schedule: 'Sunday 06:50', cron: '50 22 * * 6', group: 'weekly' },
  { id: 'weekly-drift-retrain', name: 'Weekly Drift Retrain', schedule: 'Manual, approval-gated shadow candidate', cron: 'manual confirm=weekly_drift', group: 'weekly' },
  { id: 'sector-leaders', name: 'Sector Leaders', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },
  { id: 'monthly-optuna', name: 'Monthly Optuna', schedule: 'First Sat 16:00', cron: 'first saturday of month 16:00 taipei', group: 'monthly' },
  { id: 'monthly-strategy-mining', name: 'Monthly Strategy Mining', schedule: 'First Sat 10:00', cron: 'first saturday of month 10:00 taipei', group: 'monthly' },
  { id: 'monthly-retrain', name: 'Monthly Universal Retrain', schedule: 'First Sunday 02:00', cron: 'first sunday of month 02:00 taipei', group: 'monthly' },

  { id: 'optuna-queue', name: 'Optuna Queue Processor', schedule: 'Every 6h', cron: '0 */6 * * *', group: 'daily' },
]

const CHAIN_STEP_IDS = [
  'market-close-refresh',
  'source-readiness-probe',
  'evening-chain',
  'finlab-v4-backfill',
  'update',
  'indicator-queue',
  'screener',
  'regime-compute',
  'pipeline',
  'ml-predict',
  'recommendation',
  'post-pipeline-chain',
  'verify-v2',
  'post-verify-chain',
  'model-ic-tracker',
  'linucb-reward-ledger',
  'adapt',
  'daily-report',
  'paper-active-postmarket',
  'obsidian-sync',
  'meta-learning-shadow',
  'strategy-learning',
]
const PIPELINE_CHILD_TASKS = new Set(['ml-predict', 'recommendation'])
const SCHEDULER_STATUS_SCAN_DAYS = 7
const SCHEDULER_STATUS_LEGACY_FALLBACK_DAYS = 2

export function estimateSchedulerStatusKvReads(taskCount = getSchedulerLogTaskCount()): number {
  return (SCHEDULER_STATUS_SCAN_DAYS * taskCount) +
    (Math.min(SCHEDULER_STATUS_SCAN_DAYS, SCHEDULER_STATUS_LEGACY_FALLBACK_DAYS) * taskCount)
}

export interface SchedulerDisplayLogCandidate {
  date: string
  log?: CronLogEntry
}

export function selectSchedulerDisplayLogs(candidates: SchedulerDisplayLogCandidate[]): {
  lastAttempt?: CronLogEntry
  lastEffective?: CronLogEntry
} {
  let lastAttempt: CronLogEntry | undefined
  let lastEffective: CronLogEntry | undefined

  for (const candidate of candidates) {
    if (!candidate.log) continue
    if (!lastAttempt) lastAttempt = candidate.log
    if (!lastEffective && candidate.log.status !== 'skipped') {
      lastEffective = candidate.log
    }
    if (lastAttempt && lastEffective) break
  }

  return { lastAttempt, lastEffective }
}

function formatDuration(durationMs?: number | null): string {
  if (durationMs == null) return 'N/A'
  if (durationMs < 1000) return '<1s'
  if (durationMs >= 60000) {
    return `${Math.floor(durationMs / 60000)}m${Math.floor((durationMs % 60000) / 1000)}s`
  }
  if (durationMs < 10000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.floor(durationMs / 1000)}s`
}

function inferShortRunConcern(def: JobDef, log?: CronLogEntry): {
  durationConcern: SchedulerDurationConcern
  durationConcernReason?: string
} {
  if (!log || log.duration_ms == null || log.duration_ms >= 2000) return { durationConcern: null }

  const summary = `${log.summary ?? ''} ${log.error ?? ''}`.toLowerCase()
  const status = log.status
  const expectedTriggerOrDerived =
    status === 'triggered' ||
    status === 'running' ||
    summary.includes('callback expected') ||
    summary.includes('awaiting callback') ||
    summary.includes('triggered') ||
    summary.includes('derived from pipeline') ||
    summary.includes('already running') ||
    summary.includes('queue accepted') ||
    summary.includes('shard') ||
    summary.includes('run_id') ||
    summary.includes('execution_id') ||
    summary.includes('job=')

  if (expectedTriggerOrDerived) {
    return {
      durationConcern: 'expected_short',
      durationConcernReason: 'short trigger/callback/derived run; final work is tracked by callback or downstream job',
    }
  }

  if (status === 'success') {
    return {
      durationConcern: 'suspicious_short',
      durationConcernReason: 'success under 2s without trigger/callback evidence',
    }
  }

  return { durationConcern: null }
}

export function getSchedulerScanDates(): string[] {
  const dates: string[] = []
  const now = new Date(Date.now() + 8 * 3600_000)
  for (let i = 0; i < SCHEDULER_STATUS_SCAN_DAYS; i += 1) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

function parseLogTime(ts?: string): number | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

function getDisplayLog(logs: CronLogEntry[] | undefined, taskId: string): CronLogEntry | undefined {
  const log = logs?.find((entry) => entry.task === taskId)
  if (!log) return undefined
  if (!log.timestamp && log.summary === 'no log for this date') return undefined
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

function parseNextRunForSort(value: string): number {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  const nowTw = new Date(Date.now() + 8 * 3600_000)
  const candidate = new Date(Date.UTC(
    nowTw.getUTCFullYear(),
    Number.parseInt(match[1], 10) - 1,
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
    Number.parseInt(match[4], 10),
    0,
    0,
  ))
  if (candidate < nowTw) candidate.setUTCFullYear(candidate.getUTCFullYear() + 1)
  return candidate.getTime()
}

function nextRunTwDate(value: string): string | null {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2})$/)
  if (!match) return null
  const nowTw = new Date(Date.now() + 8 * 3600_000)
  const candidate = new Date(Date.UTC(
    nowTw.getUTCFullYear(),
    Number.parseInt(match[1], 10) - 1,
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
    Number.parseInt(match[4], 10),
    0,
    0,
  ))
  if (candidate < nowTw) candidate.setUTCFullYear(candidate.getUTCFullYear() + 1)
  return candidate.toISOString().slice(0, 10)
}

function isWeekdayTw(date: string): boolean {
  const d = new Date(`${date}T00:00:00+08:00`)
  const day = d.getDay()
  return day >= 1 && day <= 5
}

function runningSlaMs(def?: Pick<JobDef, 'id' | 'group'>): number {
  if (!def) return 60 * 60_000
  if (def.id === 'monthly-retrain') return 8 * 60 * 60_000
  if (def.id === 'monthly-strategy-mining') return 4 * 60 * 60_000
  if (def.id === 'monthly-optuna') return 4 * 60 * 60_000
  if (def.id === 'weekly-optuna') return 3 * 60 * 60_000
  if (def.group === 'weekly' || def.group === 'monthly') return 2 * 60 * 60_000
  if (def.group === 'pipeline_chain') return 90 * 60_000
  if (def.group === 'intraday') return 20 * 60_000
  return 45 * 60_000
}

function formatAgeForSummary(ageMs: number): string {
  if (ageMs >= 60 * 60_000) {
    const hours = Math.floor(ageMs / 60 / 60_000)
    const minutes = Math.floor((ageMs % (60 * 60_000)) / 60_000)
    return `${hours}h${minutes}m`
  }
  return `${Math.max(1, Math.floor(ageMs / 60_000))}m`
}

function logAgeMs(log?: CronLogEntry, nowMs = Date.now()): number | null {
  if (!log?.timestamp) return null
  const ts = Date.parse(log.timestamp)
  if (!Number.isFinite(ts)) return null
  return Math.max(0, nowMs - ts)
}

export function resolveSchedulerLogStatus(
  log?: CronLogEntry,
  def?: Pick<JobDef, 'id' | 'group'>,
  nowMs = Date.now(),
): SchedulerResolvedStatus {
  if (!log) return { status: null, staleRunning: false }
  if (log.status === 'success') return { status: 'success', staleRunning: false }
  if (log.status === 'error') return { status: 'failed', staleRunning: false }
  if (log.status === 'skipped') return { status: 'skip', staleRunning: false }
  if (log.status === 'triggered' || log.status === 'running') {
    const ageMs = logAgeMs(log, nowMs)
    const slaMs = runningSlaMs(def)
    if (ageMs != null && ageMs > slaMs) {
      return {
        status: 'failed',
        staleRunning: true,
        staleReason: `stale ${log.status}: no final callback after ${formatAgeForSummary(ageMs)}; SLA ${formatAgeForSummary(slaMs)}`,
      }
    }
    return { status: 'running', staleRunning: false }
  }
  return { status: null, staleRunning: false }
}

function inferIdleStatus(def: JobDef, nextRun: string, today: string): SchedulerLastStatus {
  if (nextRunTwDate(nextRun) === today) return 'waiting'
  if (def.group === 'pipeline_chain' && def.chainIndex != null && def.chainIndex > 1 && isWeekdayTw(today)) return 'waiting'
  return 'sleep'
}

export async function getSchedulerStatus(env: Bindings) {
  const dates = getSchedulerScanDates()
  const displayDates = dates.slice(0, 7)
  const today = dates[0]

  const allLogs: Record<string, CronLogEntry[]> = {}
  await Promise.all(
    dates.map(async (date, index) => {
      allLogs[date] = await getCronLogs(env.KV, date, {
        legacyFallback: index < SCHEDULER_STATUS_LEGACY_FALLBACK_DAYS,
      })
    }),
  )

  const jobs = await Promise.all(JOB_DEFS.map(async (def) => {
    const todayLog = getDisplayLog(allLogs[today], def.id) ?? inferPipelineChildLog(allLogs[today], def.id)
    const nextRun = await getNextRunApproxWithPolicy({ task: def.id, cron: def.cron, kv: env.KV })

    const displayLogs = dates.map((date) => ({
      date,
      log: getDisplayLog(allLogs[date], def.id) ?? inferPipelineChildLog(allLogs[date], def.id),
    }))
    const { lastAttempt, lastEffective } = selectSchedulerDisplayLogs(displayLogs)
    const lastLog = lastAttempt ?? lastEffective

    const history7d = displayDates.map((date) => {
      const log = getDisplayLog(allLogs[date], def.id) ?? inferPipelineChildLog(allLogs[date], def.id)
      if (!log || log.status === 'skipped' || log.status === 'triggered' || log.status === 'running') return 'skip'
      return log.status === 'success' ? 'success' : 'failed'
    }).reverse()

    const resolvedToday = resolveSchedulerLogStatus(todayLog, def)
    const lastStatus = resolvedToday.status ?? inferIdleStatus(def, nextRun, today)

    const lastDuration = formatDuration(lastLog?.duration_ms)
    const shortRun = inferShortRunConcern(def, lastLog)

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
      lastRunAt: lastLog?.timestamp ?? null,
      lastAttempt: lastAttempt?.timestamp ? formatTimestamp(lastAttempt.timestamp) : 'N/A',
      lastAttemptAt: lastAttempt?.timestamp ?? null,
      lastAttemptStatus: lastAttempt?.status ?? 'none',
      lastEffectiveRun: lastEffective?.timestamp ? formatTimestamp(lastEffective.timestamp) : 'N/A',
      lastEffectiveRunAt: lastEffective?.timestamp ?? null,
      lastEffectiveStatus: lastEffective?.status ?? 'none',
      lastStatus,
      lastDuration,
      durationConcern: shortRun.durationConcern,
      durationConcernReason: shortRun.durationConcernReason,
      lastError: resolvedToday.staleReason ?? todayLog?.error ?? lastLog?.error,
      nextRun,
      history7d,
      rate7d: totalCount > 0 ? `${successCount}/${totalCount}` : 'N/A',
      summary: lastLog?.summary || '',
      details: lastLog?.details ?? [],
      consolidation: getSchedulerDependencySpec(def.id) ?? null,
    }
  }))

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
    .sort((a, b) => parseNextRunForSort(a.nextRun) - parseNextRunForSort(b.nextRun))[0]

  const dagSteps = CHAIN_STEP_IDS.map((jobId) => {
    const job = jobs.find((row) => row.id === jobId)
    return {
      id: jobId,
      name: job?.name ?? jobId,
      duration: job?.lastDuration ?? 'N/A',
      status: job?.lastStatus ?? 'skip',
      lastRun: job?.lastRun ?? 'N/A',
      summary: job?.summary ?? '',
    }
  })

  const heatmapJobs = ['pipeline', 'ml-predict', 'intraday-rescore', 'morning-setup', 'us-leading', 'weekly-cleanup', 'weekly-audit', 'obsidian-sync']
  const heatmap = heatmapJobs.map((jobId) => {
    const job = jobs.find((row) => row.id === jobId)
    return {
      name: job?.name || jobId,
      cells: displayDates.map((date) => {
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
    dates: displayDates.reverse(),
  }
}
