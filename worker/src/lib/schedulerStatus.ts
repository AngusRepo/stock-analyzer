/**
 * schedulerStatus.ts — Scheduler Dashboard API
 *
 * 從 KV cron logs 讀取 7 天歷史，組合成 dashboard 需要的資料結構。
 */
import type { Bindings } from '../types'
import { getCronLogs, type CronLogEntry } from './cronLogger'

// ── Job 定義（對齊 Cloud Scheduler 20 jobs）──────────────────────────────────

interface JobDef {
  id: string
  name: string
  schedule: string        // human-readable TW time
  cron: string            // raw cron expression (UTC)
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'monthly' | 'daily'
  chainIndex?: number     // for pipeline chain ordering
}

// 2026-04-21 audit: JOB_DEFS aligned 1-1 with actual runWithLog(task, …) keys
// in src/index.ts cron handlers. Adding / renaming an entry here without a
// matching worker runWithLog call will result in perpetual red-light (404 on
// KV cron:log:<id>:<date>).
const JOB_DEFS: JobDef[] = [
  // ── Pipeline chain ────────────────────────────────────────────────────────
  { id: 'pre-market-warmup', name: 'Pre-market Warmup', schedule: 'Weekdays 08:50', cron: '50 0 * * 1-5', group: 'pipeline_chain', chainIndex: 0 },
  { id: 'ml-warmup',         name: 'ML Warmup',         schedule: 'Weekdays 17:15', cron: '15 9 * * 1-5', group: 'pipeline_chain', chainIndex: 1 },
  { id: 'pipeline',          name: 'Pipeline',          schedule: 'Weekdays 17:30', cron: '30 9 * * 1-5', group: 'pipeline_chain', chainIndex: 2 },
  { id: 'ml-predict',        name: 'ML Predict',        schedule: 'After pipeline', cron: '',            group: 'pipeline_chain', chainIndex: 3 },
  { id: 'recommendation',    name: 'Daily Recommendation', schedule: 'After ML predict', cron: '',       group: 'pipeline_chain', chainIndex: 4 },

  // ── Daily (all weekday-only) ──────────────────────────────────────────────
  { id: 'us-leading',              name: 'US Leading',              schedule: 'Mon-Fri 06:30', cron: '30 22 * * SUN-THU', group: 'daily' },
  { id: 'news-analyst',            name: 'News Analyst',            schedule: 'Mon-Fri 06:45', cron: '45 22 * * SUN-THU', group: 'daily' },
  { id: 'night-repredict',         name: 'Night Re-predict',        schedule: 'Mon-Fri 07:00', cron: '0 23 * * SUN-THU',  group: 'daily' },
  { id: 'morning-setup',           name: 'Morning Setup',           schedule: 'Mon-Fri 07:15', cron: '15 23 * * SUN-THU', group: 'daily' },
  { id: 'morning-briefing',        name: 'Morning Briefing',        schedule: 'Mon-Fri 07:50', cron: '50 23 * * SUN-THU', group: 'daily' },
  { id: 'daily-snapshot',          name: 'Daily Snapshot',          schedule: 'Weekdays 14:20', cron: '20 6 * * 1-5',     group: 'daily' },
  { id: 'adapt',                   name: 'Adapt Params',            schedule: 'Weekdays 18:20', cron: '20 10 * * 1-5',    group: 'daily' },
  { id: 'daily-report',            name: 'Daily Report',            schedule: 'Weekdays 18:25', cron: '25 10 * * 1-5',    group: 'daily' },
  { id: 'obsidian-daily',          name: 'Obsidian Sync',           schedule: 'Weekdays 18:40', cron: '40 10 * * 1-5',    group: 'daily' },
  { id: 'regime-compute',          name: 'HMM Regime',              schedule: 'Weekdays 18:50', cron: '50 10 * * 1-5',    group: 'daily' },
  { id: 'verify-v2',               name: 'Verify (V2 LangGraph)',   schedule: 'Weekdays 19:00', cron: '0 11 * * 1-5',     group: 'daily' },
  { id: 'debate-memory-retention', name: 'Debate Memory Retention', schedule: 'Daily 03:00',    cron: '0 19 * * *',       group: 'daily' },

  // ── Intraday ──────────────────────────────────────────────────────────────
  { id: 'intraday-check',   name: 'Intraday Check',   schedule: 'Mon-Fri 09-13h per-min', cron: '* 1-5 * * 1-5', group: 'intraday' },
  // 4 schedules share one log key; Dashboard shows last run for the day.
  { id: 'intraday-rescore', name: 'Intraday Re-score (10/11/12/12:30)', schedule: '10:00 / 11:00 / 12:00 / 12:30', cron: '0 2,3,4 * * 1-5 + 30 4 * * 1-5', group: 'intraday' },
  { id: 'eod-exit',         name: 'EOD Exit',         schedule: 'Weekdays 13:25',         cron: '25 5 * * 1-5',  group: 'intraday' },

  // ── Weekly ────────────────────────────────────────────────────────────────
  { id: 'weekly-audit',     name: 'Weekly Audit',        schedule: 'Friday 18:30',  cron: '30 10 * * 5', group: 'weekly' },
  { id: 'model-ic-tracker', name: 'Model IC Tracker',    schedule: 'Friday 19:30',  cron: '30 11 * * 5', group: 'weekly' },
  { id: 'weekly-cleanup',   name: 'Weekly Cleanup',      schedule: 'Sunday 04:00',  cron: '0 20 * * 6',  group: 'weekly' },
  { id: 'weekly-backtest',  name: 'Weekly Backtest/MC',  schedule: 'Sunday 06:00',  cron: '0 22 * * 6',  group: 'weekly' },
  { id: 'weekly-optuna',    name: 'Weekly Optuna',       schedule: 'Sunday 06:30',  cron: '30 22 * * 6', group: 'weekly' },

  // ── Multi-day / event-driven ─────────────────────────────────────────────
  { id: 'optuna-queue',     name: 'Optuna Queue Processor', schedule: 'Every 6h',   cron: '0 */6 * * *', group: 'daily' },
]

// DAG steps for pipeline
const DAG_STEPS = [
  'Bulk Fetch', 'Screener', 'ML Predict', 'Recommend', 'LLM Reason', 'Write D1',
]

// ── Helper: get last 7 trading dates ─────────────────────────────────────────

function getLast7Dates(): string[] {
  const dates: string[] = []
  const now = new Date(Date.now() + 8 * 3600_000) // TW time
  for (let i = 0; i < 10 && dates.length < 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dow = d.getDay()
    if (dow >= 1 && dow <= 5) { // weekdays only
      dates.push(d.toISOString().slice(0, 10))
    }
  }
  return dates
}

// ── Helper: compute next run from cron (simple approximation) ────────────────

function getNextRunApprox(cron: string): string {
  if (!cron) return '—'
  // Parse cron: minute hour dom month dow
  const parts = cron.split(' ')
  if (parts.length < 5) return '—'
  const [min, hour, , , dow] = parts
  const now = new Date(Date.now() + 8 * 3600_000)
  const targetHourUtc = parseInt(hour)
  const targetMin = parseInt(min)
  // 2026-04-21 fix: step/list/range expressions (*/6, 2,3,4) were NaN-poisoning
  // setHours and crashing toISOString → 500 on /api/scheduler/status.
  if (!Number.isFinite(targetHourUtc) || !Number.isFinite(targetMin)) {
    return '—'
  }
  const targetHourTW = targetHourUtc + 8 // UTC → TW

  // Find next matching day
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(targetHourTW, targetMin, 0, 0)

    if (candidate <= now) continue

    const dayNum = candidate.getDay()
    // Check if dow matches
    if (dow === '*') {
      return `${candidate.getMonth() + 1}/${candidate.getDate()} ${String(targetHourTW % 24).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`
    }
    const allowedDays = dow.includes('-')
      ? expandRange(dow)
      : dow.split(',').map(Number).filter(Number.isFinite)
    if (allowedDays.includes(dayNum)) {
      return `${candidate.getMonth() + 1}/${candidate.getDate()} ${String(targetHourTW % 24).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`
    }
  }
  return '—'
}

function expandRange(r: string): number[] {
  const [start, end] = r.split('-').map(Number)
  const result: number[] = []
  for (let i = start; i <= end; i++) result.push(i)
  return result
}

// ── Main: build scheduler status ─────────────────────────────────────────────

export async function getSchedulerStatus(env: Bindings) {
  const dates = getLast7Dates()
  const today = dates[0]

  // Fetch 7 days of cron logs in parallel
  const allLogs: Record<string, CronLogEntry[]> = {}
  await Promise.all(
    dates.map(async (date) => {
      allLogs[date] = await getCronLogs(env.KV, date)
    })
  )

  // Build per-job status
  const jobs = JOB_DEFS.map(def => {
    // Find today's log for this job
    const todayLog = allLogs[today]?.find(l => l.task === def.id)

    // Find most recent log across all dates
    let lastLog: CronLogEntry | undefined
    for (const date of dates) {
      const log = allLogs[date]?.find(l => l.task === def.id && l.status !== 'skipped')
      if (log) { lastLog = log; break }
    }

    // Build 7-day history
    const history7d = dates.map(date => {
      const log = allLogs[date]?.find(l => l.task === def.id)
      if (!log || log.status === 'skipped') return 'skip'
      return log.status === 'success' ? 'success' : 'failed'
    }).reverse() // oldest first

    const lastStatus = lastLog?.status === 'success' ? 'success' as const
                     : lastLog?.status === 'error' ? 'failed' as const
                     : 'skip' as const
    const lastDuration = lastLog?.duration_ms
      ? lastLog.duration_ms >= 60000 ? `${Math.floor(lastLog.duration_ms / 60000)}m${Math.floor((lastLog.duration_ms % 60000) / 1000)}s`
      : `${Math.floor(lastLog.duration_ms / 1000)}s`
      : '—'

    const successCount = history7d.filter(h => h === 'success').length
    const totalCount = history7d.filter(h => h !== 'skip').length

    return {
      id: def.id,
      name: def.name,
      schedule: def.schedule,
      cron: def.cron,
      group: def.group,
      chainIndex: def.chainIndex,
      lastRun: lastLog?.timestamp ? formatTimestamp(lastLog.timestamp) : '—',
      lastStatus,
      lastDuration,
      lastError: lastLog?.error,
      nextRun: getNextRunApprox(def.cron),
      history7d,
      rate7d: totalCount > 0 ? `${successCount}/${totalCount}` : '—',
      summary: lastLog?.summary || '',
    }
  })

  // Stats
  const failed24h = jobs.filter(j => {
    const todayLog = allLogs[today]?.find(l => l.task === j.id && l.status === 'error')
    return !!todayLog
  }).length
  const allRuns = jobs.flatMap(j => j.history7d.filter(h => h !== 'skip'))
  const successRate = allRuns.length > 0
    ? Math.round(allRuns.filter(r => r === 'success').length / allRuns.length * 1000) / 10
    : 100

  // Find next upcoming job
  const nextJob = jobs
    .filter(j => j.nextRun !== '—')
    .sort((a, b) => a.nextRun.localeCompare(b.nextRun))[0]

  // DAG: read pipeline step timing from KV
  let dagSteps = DAG_STEPS.map(name => ({ name, duration: '—', status: 'skip' as string }))
  try {
    const pipelineLog = allLogs[today]?.find(l => l.task === 'pipeline' && l.status === 'success')
    if (pipelineLog?.details) {
      dagSteps = DAG_STEPS.map(name => {
        const detail = pipelineLog.details?.find(d => d.includes(name))
        return {
          name,
          duration: detail?.match(/(\d+[ms]+\d*[s]*)/)?.[1] || '—',
          status: detail?.includes('✗') ? 'failed' : 'success',
        }
      })
    }
  } catch { /* fallback to defaults */ }

  // Heatmap: group by important jobs
  const heatmapJobs = ['pipeline', 'ml-predict', 'rescore-10', 'morning-setup', 'us-leading', 'weekly-cleanup', 'weekly-audit', 'obsidian-daily']
  const heatmap = heatmapJobs.map(jobId => {
    const job = jobs.find(j => j.id === jobId)
    return {
      name: job?.name || jobId,
      cells: dates.map(date => {
        const log = allLogs[date]?.find(l => l.task === jobId)
        if (!log || log.status === 'skipped') return 'skip'
        return log.status === 'success' ? 'success' : 'failed'
      }).reverse(),
    }
  })

  return {
    stats: {
      total: JOB_DEFS.length,
      active: JOB_DEFS.length,
      failed24h: failed24h,
      successRate7d: successRate,
      nextJob: nextJob?.name || '—',
      nextIn: nextJob?.nextRun || '—',
    },
    jobs,
    dag: {
      lastRun: allLogs[today]?.find(l => l.task === 'pipeline')?.timestamp || '—',
      totalDuration: allLogs[today]?.find(l => l.task === 'pipeline')?.duration_ms || 0,
      steps: dagSteps,
    },
    heatmap,
    dates: dates.reverse(), // oldest first for display
  }
}

function formatTimestamp(ts: string): string {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    d.setHours(d.getHours() + 8) // UTC → TW
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return ts }
}
