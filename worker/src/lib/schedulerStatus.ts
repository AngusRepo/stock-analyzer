/**
 * schedulerStatus.ts - Scheduler dashboard status builder
 */

import type { Bindings } from '../types'
import { getCronLogs, type CronLogEntry } from './schedulerRunLogger'
import { getNextRunApproxWithPolicy } from './schedulerPolicy'
import { getSchedulerDependencySpec } from './schedulerDependencyMap'

interface JobDef {
  id: string
  name: string
  schedule: string
  cron: string
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'monthly' | 'daily'
  chainIndex?: number
  legacyLogIds?: string[]
}

type SchedulerLastStatus = 'success' | 'failed' | 'running' | 'skip' | 'waiting' | 'sleep'
type SchedulerResolvedStatus = {
  status: SchedulerLastStatus | null
  staleRunning: boolean
  staleReason?: string
}
export type SchedulerStatusScope = 'today' | 'historical_replay' | 'schedule'
export type SchedulerDisplayStatus = {
  status: SchedulerLastStatus
  statusScope: SchedulerStatusScope
  statusRunDate: string | null
  staleReason?: string
}
type SchedulerDurationConcern = 'expected_short' | 'suspicious_short' | null

const JOB_DEFS: JobDef[] = [
  { id: 'pre-market-warmup', name: 'Pre-market Warmup', schedule: 'Weekdays 08:50', cron: '50 0 * * 1-5', group: 'pipeline_chain', chainIndex: 0 },
  { id: 'market-close-refresh', name: 'Market Close Refresh', schedule: 'Weekdays 18:10', cron: '10 10 * * 1-5', group: 'pipeline_chain', chainIndex: 1 },
  { id: 'evening-chain', name: 'Evening Chain', schedule: 'Weekdays 21:00', cron: '0 13 * * 1-5', group: 'pipeline_chain', chainIndex: 2 },
  { id: 'finlab-v4-backfill', name: 'FinLab V4 Backfill', schedule: 'Inside evening chain', cron: '', group: 'pipeline_chain', chainIndex: 3 },
  { id: 'finlab-backfill-watchdog', name: 'FinLab Pending Watchdog', schedule: 'Weekdays 21:20-23:50 / 10m', cron: '*/10 13-15 * * 1-5', group: 'pipeline_chain', chainIndex: 3 },
  { id: 'allocator-ev-lifecycle-watchdog', name: 'Allocator EV Lifecycle Watchdog', schedule: 'Weekdays 21:00-01:50 / 10m', cron: '*/10 13-17 * * 1-5', group: 'pipeline_chain', chainIndex: 13 },
  { id: 'active8-oof-daily', name: 'Active-8 OOF Materialize', schedule: 'Weekdays 01:55', cron: '55 17 * * 1-5', group: 'pipeline_chain', chainIndex: 14 },
  { id: 'update', name: 'Market Data Update', schedule: 'After FinLab canonical ready', cron: '', group: 'pipeline_chain', chainIndex: 4 },
  { id: 'indicator-queue', name: 'Indicator Queue', schedule: 'After update readiness', cron: '', group: 'pipeline_chain', chainIndex: 5 },
  { id: 'screener', name: 'Screener', schedule: 'After indicators', cron: '', group: 'pipeline_chain', chainIndex: 6 },
  { id: 'regime-compute', name: 'HMM Regime', schedule: 'Before pipeline recommendation', cron: '', group: 'pipeline_chain', chainIndex: 7 },
  { id: 's12-structure-snapshot', name: 'S12 Structure Snapshot', schedule: 'After regime, before allocator EV readiness', cron: '', group: 'pipeline_chain', chainIndex: 8 },
  { id: 'allocator-ev-readiness', name: 'Allocator EV Readiness', schedule: 'After S12 structure snapshot', cron: '', group: 'pipeline_chain', chainIndex: 9 },
  { id: 'pipeline', name: 'Pipeline', schedule: 'After screener + regime + S12 + allocator EV readiness', cron: '', group: 'pipeline_chain', chainIndex: 10 },
  { id: 'ml-predict', name: 'ML Predict', schedule: 'Inside pipeline', cron: '', group: 'pipeline_chain', chainIndex: 11 },
  { id: 'recommendation', name: 'Daily Recommendation', schedule: 'Inside pipeline', cron: '', group: 'pipeline_chain', chainIndex: 12 },
  { id: 'post-pipeline-chain', name: 'Post Pipeline Callback', schedule: 'After pipeline callback', cron: '', group: 'pipeline_chain', chainIndex: 13 },
  { id: 'allocator-ev-feature-snapshot-backfill', name: 'Allocator EV Feature Snapshot', schedule: 'Inside post-pipeline callback before verify', cron: '', group: 'pipeline_chain', chainIndex: 14 },
  { id: 'verify-v2', name: 'Verify (V2 LangGraph)', schedule: 'After pipeline callback', cron: '', group: 'pipeline_chain', chainIndex: 15 },
  { id: 'post-verify-chain', name: 'Post Verify Callback', schedule: 'After verify callback', cron: '', group: 'pipeline_chain', chainIndex: 16 },
  { id: 'model-ic-rolling', name: 'Model IC Rolling', schedule: 'After verify callback', cron: '', group: 'pipeline_chain', chainIndex: 17 },
  { id: 'model-ic-full-check', name: 'Model IC Full Check', schedule: 'Friday 19:30', cron: '30 11 * * 5', group: 'weekly', legacyLogIds: ['model-ic-tracker'] },
  { id: 'linucb-reward-ledger', name: 'LinUCB Reward Ledger', schedule: 'After rolling IC', cron: '', group: 'pipeline_chain', chainIndex: 18 },
  { id: 'adapt', name: 'Adapt Params', schedule: 'After LinUCB ledger', cron: '', group: 'pipeline_chain', chainIndex: 19 },
  { id: 'daily-report', name: 'Daily Report', schedule: 'After adapt', cron: '', group: 'pipeline_chain', chainIndex: 20 },
  { id: 'paper-active-postmarket', name: 'Paper Active Postmarket', schedule: 'After daily report', cron: '', group: 'pipeline_chain', chainIndex: 21 },
  { id: 'obsidian-sync', name: 'Obsidian Sync', schedule: 'After paper-active postmarket', cron: '', group: 'pipeline_chain', chainIndex: 22 },
  { id: 'meta-learning-shadow', name: 'Meta Learning Shadow', schedule: 'After obsidian sync', cron: '', group: 'pipeline_chain', chainIndex: 23 },
  { id: 'strategy-learning', name: 'Strategy Learning', schedule: 'After meta shadow / historical reruns', cron: '', group: 'pipeline_chain', chainIndex: 24 },

  { id: 'us-leading', name: 'US Leading', schedule: 'Mon-Fri 06:30', cron: '30 22 * * SUN-THU', group: 'daily' },
  { id: 'news-analyst', name: 'News Analyst', schedule: 'Mon-Fri 06:45', cron: '45 22 * * SUN-THU', group: 'daily' },
  { id: 'morning-setup', name: 'Morning Setup / Debate', schedule: 'Mon-Fri 07:15', cron: '15 23 * * SUN-THU', group: 'daily' },
  { id: 'morning-briefing', name: 'Morning Briefing', schedule: 'Mon-Fri 07:50', cron: '50 23 * * SUN-THU', group: 'daily' },
  { id: 'daily-snapshot', name: 'Daily Snapshot', schedule: 'Weekdays 14:20', cron: '20 6 * * 1-5', group: 'daily' },
  { id: 'external-evidence', name: 'External Evidence', schedule: 'Weekdays 23:15', cron: '15 15 * * 1-5', group: 'daily' },
  { id: 'debate-memory-retention', name: 'Debate Memory Retention', schedule: 'Daily 03:00', cron: '0 19 * * *', group: 'daily' },
  { id: 'artifact-reconcile', name: 'Artifact Reconcile', schedule: 'Daily 02:05', cron: '5 18 * * *', group: 'daily' },
  { id: 'legacy-evidence-migration', name: 'Legacy Evidence Migration', schedule: 'Daily 01:40??5:40 hourly', cron: '40 17-21 * * *', group: 'daily' },
  { id: 'legacy-strategy-evidence-migration', name: 'Legacy Strategy Evidence Migration', schedule: 'Daily 01:50??5:50 hourly', cron: '50 17-21 * * *', group: 'daily' },
  { id: 'legacy-hot-data-retirement', name: 'Legacy Hot Data Retirement', schedule: 'Daily 01:10??5:10 hourly', cron: '10 17-21 * * *', group: 'daily' },
  { id: 'd1-evidence-scrub', name: 'D1 Evidence Scrub', schedule: 'Daily 02:20', cron: '20 18 * * *', group: 'daily' },
  { id: 'r2-retention-sweep', name: 'R2 Retention Sweep', schedule: 'Daily 02:40', cron: '40 18 * * *', group: 'daily' },
  { id: 'orphan-reachability-gc', name: 'Orphan Reachability GC', schedule: 'Daily 03:00', cron: '0 19 * * *', group: 'daily' },
  { id: 'cleanup-dlq-replay', name: 'Cleanup DLQ Replay', schedule: 'Daily 03:20', cron: '20 19 * * *', group: 'daily' },
  { id: 'storage-health-check', name: 'Storage Health Check', schedule: 'Daily 06:45', cron: '45 22 * * *', group: 'daily' },
  { id: 'storage-integrity-audit', name: 'Storage Integrity Audit', schedule: 'Sunday 03:30', cron: '30 19 * * 6', group: 'weekly' },

  { id: 'intraday-check', name: 'Intraday Check', schedule: 'Mon-Fri 09:00-13:30 per-min', cron: '* 1-4 * * 1-5 + 0-30 5 * * 1-5', group: 'intraday' },
  { id: 'rescore-10', name: 'Intraday Re-score 10:00', schedule: 'Weekdays 10:00', cron: '0 2 * * 1-5', group: 'intraday' },
  { id: 'rescore-11', name: 'Intraday Re-score 11:00', schedule: 'Weekdays 11:00', cron: '0 3 * * 1-5', group: 'intraday' },
  { id: 'rescore-12', name: 'Intraday Re-score 12:00', schedule: 'Weekdays 12:00', cron: '0 4 * * 1-5', group: 'intraday' },
  { id: 'rescore-1230', name: 'Intraday Re-score 12:30', schedule: 'Weekdays 12:30', cron: '30 4 * * 1-5', group: 'intraday' },
  { id: 'eod-exit', name: 'EOD Exit', schedule: 'Weekdays 13:25', cron: '25 5 * * 1-5', group: 'intraday' },
  { id: 'post-close-price-refresh', name: 'Post-close Price Refresh', schedule: 'Weekdays 13:40', cron: '40 5 * * 1-5', group: 'intraday' },

  { id: 'weekly-audit', name: 'Weekly Audit', schedule: 'Friday 18:30', cron: '30 10 * * 5', group: 'weekly' },
  { id: 'weekly-cleanup', name: 'Weekly Cleanup', schedule: 'Sunday 04:00 (no retrain)', cron: '0 20 * * 6', group: 'weekly' },
  { id: 'weekly-backtest', name: 'Weekly Validation/MC', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'alpha-quality', name: 'Alpha Quality', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'weekly-optuna', name: 'Weekly Optuna', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },
  { id: 'adaptive-meta-policy-replay', name: 'Adaptive Meta Policy Replay', schedule: 'Sunday 06:40', cron: '40 22 * * 6', group: 'weekly' },
  { id: 'strategy-threshold-calibration', name: 'Strategy Threshold Calibration', schedule: 'Sunday 06:45', cron: '45 22 * * 6', group: 'weekly' },
  { id: 'linucb-multiplier-replay', name: 'LinUCB Multiplier Replay', schedule: 'Sunday 06:50', cron: '50 22 * * 6', group: 'weekly' },
  { id: 'active8-oof-weekly', name: 'Active-8 OOF Weekly Cohort', schedule: 'Sunday 07:05', cron: '5 23 * * 6', group: 'weekly' },

  { id: 'weekly-drift-retrain', name: 'Weekly Drift Retrain', schedule: 'Manual, approval-gated shadow candidate', cron: 'manual confirm=weekly_drift', group: 'weekly' },
  { id: 'sector-leaders', name: 'Sector Leaders', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },
  { id: 'monthly-optuna', name: 'Monthly Optuna', schedule: 'First Sat 16:00', cron: 'first saturday of month 16:00 taipei', group: 'monthly' },
  { id: 'active8-oof-monthly', name: 'Active-8 OOF Monthly Cohort', schedule: 'After monthly retrain callback', cron: 'event-driven', group: 'monthly' },

  { id: 'monthly-strategy-mining', name: 'Monthly Strategy Mining', schedule: 'First Sat 10:00', cron: 'first saturday of month 10:00 taipei', group: 'monthly' },
  { id: 'monthly-retrain', name: 'Monthly Universal Retrain', schedule: 'First Sunday 02:00', cron: 'first sunday of month 02:00 taipei', group: 'monthly' },
  { id: 'storage-capacity-report', name: 'Storage Capacity Report', schedule: 'First day 04:30', cron: '30 4 1 * * taipei', group: 'monthly' },

  { id: 'optuna-queue', name: 'Optuna Queue Processor', schedule: 'Every 6h', cron: '0 */6 * * *', group: 'daily' },
]

const CHAIN_STEP_IDS = [
  'market-close-refresh',
  'evening-chain',
  'finlab-v4-backfill',
  'update',
  'indicator-queue',
  'screener',
  'regime-compute',
  's12-structure-snapshot',
  'allocator-ev-readiness',
  'pipeline',
  'ml-predict',
  'recommendation',
  'post-pipeline-chain',
  'allocator-ev-feature-snapshot-backfill',
  'allocator-ev-lifecycle-watchdog',
  'verify-v2',
  'post-verify-chain',
  'model-ic-rolling',
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

export function estimateSchedulerStatusKvReads(): number {
  return SCHEDULER_STATUS_SCAN_DAYS * 2 + CHAIN_STEP_IDS.filter((task) => task !== 'evening-chain').length
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

export function mergeDirectSchedulerLog(
  aggregateLogs: CronLogEntry[],
  directLog?: CronLogEntry | null,
): CronLogEntry[] {
  if (!directLog?.task || !directLog.timestamp) return aggregateLogs
  const index = aggregateLogs.findIndex((entry) => entry.task === directLog.task)
  if (index < 0) return [...aggregateLogs, directLog]

  const aggregateTimestamp = Date.parse(aggregateLogs[index].timestamp ?? '')
  const directTimestamp = Date.parse(directLog.timestamp)
  if (Number.isFinite(aggregateTimestamp) && (!Number.isFinite(directTimestamp) || aggregateTimestamp > directTimestamp)) {
    return aggregateLogs
  }
  const merged = [...aggregateLogs]
  merged[index] = directLog
  return merged
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

export type DurablePipelineStageDisplayRow = {
  business_date: string
  stage: 'post_pipeline_chain' | 'verify_v2' | 'post_verify_chain'
  canonical_run_id: string
  status: 'queued' | 'running' | 'waiting' | 'success' | 'error'
  attempt_count: number
  updated_at: string
  last_error: string | null
}

const DURABLE_STAGE_JOB_IDS: Record<DurablePipelineStageDisplayRow['stage'], string> = {
  post_pipeline_chain: 'post-pipeline-chain',
  verify_v2: 'verify-v2',
  post_verify_chain: 'post-verify-chain',
}

function sqliteUtcTimestamp(value: string): string {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized.replace(' ', 'T')}Z`
  }
  return normalized
}

export function reconcileDurablePipelineStageStatus(input: {
  jobId: string
  runDate: string | null
  baseStatus: SchedulerLastStatus
  baseTimestamp?: string | null
  durable?: DurablePipelineStageDisplayRow
}): {
  lastStatus: SchedulerLastStatus
  lastRunAt: string
  summary: string
  lastError?: string
  recoveredFromStatus?: SchedulerLastStatus
  statusAuthority: 'durable_pipeline_stage'
  runId: string
  attemptCount: number
} | null {
  const { jobId, runDate, baseStatus, baseTimestamp, durable } = input
  if (!durable || !runDate || durable.business_date !== runDate) return null
  if (DURABLE_STAGE_JOB_IDS[durable.stage] !== jobId) return null

  const durableTimestamp = sqliteUtcTimestamp(durable.updated_at)
  const durableMs = Date.parse(durableTimestamp)
  const baseMs = baseTimestamp ? Date.parse(baseTimestamp) : Number.NEGATIVE_INFINITY
  if (!Number.isFinite(durableMs) || (Number.isFinite(baseMs) && durableMs <= baseMs)) return null

  const lastStatus: SchedulerLastStatus = durable.status === 'success'
    ? 'success'
    : durable.status === 'error'
      ? 'failed'
      : durable.status === 'waiting'
        ? 'waiting'
        : 'running'
  const recovered = baseStatus === 'failed' && lastStatus === 'success'
  const authority = `durable stage=${durable.stage} run_id=${durable.canonical_run_id} attempt=${durable.attempt_count}`

  return {
    lastStatus,
    lastRunAt: durableTimestamp,
    summary: recovered ? `Recovered; ${authority}` : `${durable.status}; ${authority}`,
    lastError: lastStatus === 'failed' ? (durable.last_error || undefined) : undefined,
    recoveredFromStatus: recovered ? baseStatus : undefined,
    statusAuthority: 'durable_pipeline_stage',
    runId: durable.canonical_run_id,
    attemptCount: durable.attempt_count,
  }
}

async function loadDurablePipelineStageStates(
  db: D1Database,
  dates: string[],
): Promise<Map<string, DurablePipelineStageDisplayRow>> {
  const placeholders = dates.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT business_date, stage, canonical_run_id, status, attempt_count, updated_at, last_error
      FROM pipeline_stage_runs
     WHERE business_date IN (${placeholders})
       AND stage IN ('post_pipeline_chain', 'verify_v2', 'post_verify_chain')
  `).bind(...dates).all<DurablePipelineStageDisplayRow>()
  return new Map((result.results ?? []).map((row) => [
    `${row.business_date}:${DURABLE_STAGE_JOB_IDS[row.stage]}`,
    row,
  ]))
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

function getJobDisplayLog(logs: CronLogEntry[] | undefined, def: JobDef): CronLogEntry | undefined {
  for (const taskId of [def.id, ...(def.legacyLogIds ?? [])]) {
    const log = getDisplayLog(logs, taskId)
    if (log) return log
  }
  return inferPipelineChildLog(logs, def.id)
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
      /recos_updated[=:](\d+)/i.test(summary) ||
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

function inferIdleStatus(def: Pick<JobDef, 'group' | 'chainIndex'>, nextRun: string, today: string): SchedulerLastStatus {
  if (nextRunTwDate(nextRun) === today) return 'waiting'
  if (def.group === 'pipeline_chain' && def.chainIndex != null && def.chainIndex > 1 && isWeekdayTw(today)) return 'waiting'
  return 'sleep'
}

function timestampTwDate(timestamp?: string): string | null {
  const timestampMs = parseLogTime(timestamp)
  if (timestampMs == null) return null
  return new Date(timestampMs + 8 * 3600_000).toISOString().slice(0, 10)
}

export function resolveSchedulerDisplayStatus(input: {
  todayLog?: CronLogEntry
  lastAttempt?: CronLogEntry
  def: Pick<JobDef, 'id' | 'group' | 'chainIndex'>
  nextRun: string
  today: string
  nowMs?: number
}): SchedulerDisplayStatus {
  const { todayLog, lastAttempt, def, nextRun, today, nowMs = Date.now() } = input
  const resolvedToday = resolveSchedulerLogStatus(todayLog, def, nowMs)
  if (resolvedToday.status) {
    return {
      status: resolvedToday.status,
      statusScope: 'today',
      statusRunDate: today,
      staleReason: resolvedToday.staleReason,
    }
  }

  const replayRunDate = String(lastAttempt?.run_date ?? '').trim()
  const isHistoricalReplay = Boolean(
    replayRunDate && replayRunDate !== today && timestampTwDate(lastAttempt?.timestamp) === today,
  )
  if (isHistoricalReplay) {
    const resolvedReplay = resolveSchedulerLogStatus(lastAttempt, def, nowMs)
    if (resolvedReplay.status) {
      return {
        status: resolvedReplay.status,
        statusScope: 'historical_replay',
        statusRunDate: replayRunDate,
        staleReason: resolvedReplay.staleReason,
      }
    }
  }

  return {
    status: inferIdleStatus(def, nextRun, today),
    statusScope: 'schedule',
    statusRunDate: null,
  }
}

export async function getSchedulerStatus(env: Bindings) {
  const dates = getSchedulerScanDates()
  const displayDates = dates.slice(0, 7)
  const today = dates[0]

  const allLogs: Record<string, CronLogEntry[]> = {}
  const durableStageStatesPromise = loadDurablePipelineStageStates(env.DB, dates).catch((error) => {
    console.warn('[schedulerStatus] durable pipeline stage read failed:', error)
    return new Map<string, DurablePipelineStageDisplayRow>()
  })
  await Promise.all(
    dates.map(async (date, index) => {
      const [aggregateLogs, directRootLog] = await Promise.all([
        getCronLogs(env.KV, date, {
          legacyFallback: index < SCHEDULER_STATUS_LEGACY_FALLBACK_DAYS,
          directFallback: false,
        }),
        env.KV.get(`scheduler:run:evening-chain:${date}`, 'json') as Promise<CronLogEntry | null>,
      ])
      allLogs[date] = mergeDirectSchedulerLog(aggregateLogs, directRootLog)
    }),
  )
  const durableStageStates = await durableStageStatesPromise
  const activeChainDate = dates.find((date) => {
    const root = allLogs[date]?.find((entry) => entry.task === 'evening-chain')
    return root?.status === 'running' || root?.status === 'triggered'
  })
  if (activeChainDate) {
    const activeTaskIds = CHAIN_STEP_IDS.filter((task) => task !== 'evening-chain')
    const directChainLogs = await Promise.all(activeTaskIds.map((task) => (
      env.KV.get(`scheduler:run:${task}:${activeChainDate}`, 'json') as Promise<CronLogEntry | null>
    )))
    allLogs[activeChainDate] = directChainLogs.reduce(
      (logs, directLog) => mergeDirectSchedulerLog(logs, directLog),
      allLogs[activeChainDate] ?? [],
    )
  }

  const jobs = await Promise.all(JOB_DEFS.map(async (def) => {
    const todayLog = getJobDisplayLog(allLogs[today], def)
    const nextRun = await getNextRunApproxWithPolicy({ task: def.id, cron: def.cron, kv: env.KV, skipKvPolicy: true })

    const displayLogs = dates.map((date) => ({
      date,
      log: getJobDisplayLog(allLogs[date], def),
    }))
    const { lastAttempt, lastEffective } = selectSchedulerDisplayLogs(displayLogs)
    const lastLog = lastAttempt ?? lastEffective

    const history7d = displayDates.map((date) => {
      const log = getJobDisplayLog(allLogs[date], def)
      if (!log || log.status === 'skipped' || log.status === 'triggered' || log.status === 'running') return 'skip'
      return log.status === 'success' ? 'success' : 'failed'
    }).reverse()

    const resolvedDisplay = resolveSchedulerDisplayStatus({
      todayLog,
      lastAttempt,
      def,
      nextRun,
      today,
    })
    const durableState = resolvedDisplay.statusRunDate
      ? durableStageStates.get(`${resolvedDisplay.statusRunDate}:${def.id}`)
      : undefined
    const durableOverride = reconcileDurablePipelineStageStatus({
      jobId: def.id,
      runDate: resolvedDisplay.statusRunDate,
      baseStatus: resolvedDisplay.status,
      baseTimestamp: lastLog?.timestamp,
      durable: durableState,
    })
    const lastStatus = durableOverride?.lastStatus ?? resolvedDisplay.status

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
      lastRun: durableOverride?.lastRunAt ? formatTimestamp(durableOverride.lastRunAt) : lastLog?.timestamp ? formatTimestamp(lastLog.timestamp) : 'N/A',
      lastRunAt: durableOverride?.lastRunAt ?? lastLog?.timestamp ?? null,
      lastAttempt: lastAttempt?.timestamp ? formatTimestamp(lastAttempt.timestamp) : 'N/A',
      lastAttemptAt: lastAttempt?.timestamp ?? null,
      lastAttemptStatus: lastAttempt?.status ?? 'none',
      lastEffectiveRun: lastEffective?.timestamp ? formatTimestamp(lastEffective.timestamp) : 'N/A',
      lastEffectiveRunAt: lastEffective?.timestamp ?? null,
      lastEffectiveStatus: lastEffective?.status ?? 'none',
      lastStatus,
      statusScope: resolvedDisplay.statusScope,
      statusRunDate: resolvedDisplay.statusRunDate,
      lastDuration,
      durationConcern: shortRun.durationConcern,
      durationConcernReason: shortRun.durationConcernReason,
      lastError: durableOverride
        ? durableOverride.lastError
        : resolvedDisplay.staleReason ?? todayLog?.error ?? lastLog?.error,
      nextRun,
      history7d,
      rate7d: totalCount > 0 ? `${successCount}/${totalCount}` : 'N/A',
      summary: durableOverride?.summary ?? lastLog?.summary ?? '',
      details: lastLog?.details ?? [],
      runId: durableOverride?.runId ?? lastLog?.run_id ?? null,
      attemptId: lastLog?.attempt_id ?? null,
      attemptCount: durableOverride?.attemptCount ?? null,
      recoveredFromStatus: durableOverride?.recoveredFromStatus ?? null,
      statusAuthority: durableOverride?.statusAuthority ?? 'scheduler_kv',
      consolidation: getSchedulerDependencySpec(def.id) ?? null,
    }
  }))

  const failed24h = jobs.filter((job) => {
    const def = JOB_DEFS.find((row) => row.id === job.id)
    const todayLog = def ? getJobDisplayLog(allLogs[today], def) : undefined
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

  const heatmapJobs = ['pipeline', 'ml-predict', 'rescore-10', 'rescore-11', 'rescore-12', 'rescore-1230', 'morning-setup', 'us-leading', 'weekly-cleanup', 'weekly-audit', 'obsidian-sync']
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
