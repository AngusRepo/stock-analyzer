import { pipelineProgressForDisplay } from './pipelineProgress'
import { loadPipelineInputWork } from './pipelineInputWork'
import { finlabProgressForDisplay } from './finlabStageProgress'
/**
 * schedulerStatus.ts - Scheduler dashboard status builder
 */

import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import { indicatorQueueDurationMs } from './indicatorQueueTiming'
import { sealedPremarketDisplay } from './schedulerPipelinePhase'
import { loadPremarketProducerStates, premarketProducerDisplay } from './premarketProducerStatus'
import { loadPremarketProgress, premarketExecutionDisplay, premarketWatchdogDisplay, premarketReadinessDisplay } from './schedulerPremarketProgress'
import type { Bindings } from '../types'
import { getCronLogs, type CronLogEntry } from './schedulerRunLogger'
import { getNextRunApproxWithPolicy } from './schedulerPolicy'
import { getSchedulerDependencySpec } from './schedulerDependencyMap'
import { eodExitSchedule, manifestRepeatingWindow, schedulerGovernanceSummary, schedulerJobAccounting } from './schedulerManifestGovernance'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  loadSchedulerExecutionTickets,
  schedulerTicketClosureDefect,
  SCHEDULER_TICKET_CONTRACT_ROOTS,
  type SchedulerExecutionTicketRow,
} from './schedulerExecutionTickets'

interface JobDef {
  id: string
  name: string
  schedule: string
  cron: string
  timeZone?: string
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'monthly' | 'daily'
  chainIndex?: number
  legacyLogIds?: string[]
}

type SchedulerLastStatus = 'success' | 'failed' | 'blocked' | 'running' | 'skip' | 'waiting' | 'sleep'
type SchedulerResolvedStatus = {
  status: SchedulerLastStatus | null
  staleRunning: boolean
  staleReason?: string
}
export type SchedulerStatusScope = 'today' | 'historical_replay' | 'schedule' | 'cadence_cycle' | 'durable_event'
export type SchedulerDisplayStatus = {
  status: SchedulerLastStatus
  statusScope: SchedulerStatusScope
  statusRunDate: string | null
  staleReason?: string
  /** A watchdog owing a receipt for this window: only an execution ticket from inside it can replace the status. */
  windowOpenedAt?: string
}
type SchedulerDurationConcern = 'expected_short' | 'suspicious_short' | null

const JOB_DEF_METADATA: JobDef[] = [
  { id: 'pre-market-warmup', name: 'Pre-market Readiness', schedule: 'Event-driven; broker health from 08:30', cron: '', group: 'pipeline_chain', chainIndex: 0 },
  { id: 'market-close-refresh', name: 'Market Close Refresh', schedule: 'Weekdays 18:10', cron: '10 10 * * 1-5', group: 'pipeline_chain', chainIndex: 1 },
  { id: 'evening-chain', name: 'Evening Chain', schedule: 'Weekdays 21:45', cron: '45 13 * * 1-5', group: 'pipeline_chain', chainIndex: 2 },
  { id: 'finlab-v4-backfill', name: 'FinLab V4 Backfill', schedule: 'Inside evening chain', cron: '', group: 'pipeline_chain', chainIndex: 3 },
  { id: 'finlab-backfill-watchdog', name: 'FinLab Pending Watchdog', schedule: 'Weekdays 21:00-23:50 / 10m', cron: '*/10 13-15 * * 1-5', group: 'pipeline_chain', chainIndex: 3 },
  { id: 'indicator-queue-watchdog', name: 'Indicator Queue Watchdog', schedule: 'Weekdays 21:00-01:55 / 5m', cron: '*/5 13-17 * * 1-5', group: 'pipeline_chain', chainIndex: 5 },
  { id: 'allocator-ev-lifecycle-watchdog', name: 'Allocator EV Lifecycle Watchdog', schedule: 'Weekdays 21:00-01:50 / 10m', cron: '*/10 13-17 * * 1-5', group: 'daily' },
  { id: 'active8-oof-daily', name: 'Active-8 Daily Evidence', schedule: 'Snapshot-ready event + daily recovery (waits for premarket)', cron: '55 17 * * 1-5', group: 'pipeline_chain' },
  { id: 'update', name: 'Market Data Update', schedule: 'After FinLab canonical ready', cron: '', group: 'pipeline_chain', chainIndex: 4 },
  { id: 'indicator-queue', name: 'Indicator Queue', schedule: 'After update readiness', cron: '', group: 'pipeline_chain', chainIndex: 5 },
  { id: 'regime-compute', name: 'HMM Regime', schedule: 'After indicators, before screener', cron: '', group: 'pipeline_chain', chainIndex: 6 },
  { id: 'hmm-maintenance', name: 'HMM Model Maintenance', schedule: 'Daily 14:00 / 20:00', cron: '0 6,12 * * *', group: 'pipeline_chain' },
  { id: 'strategy-learning-mature-evidence', name: 'Strategy Maturity Evidence', schedule: 'After same-date HMM, before screener', cron: '', group: 'pipeline_chain', chainIndex: 6.5 },
  { id: 'screener', name: 'Screener', schedule: 'After same-date HMM regime', cron: '', group: 'pipeline_chain', chainIndex: 7 },
  { id: 'screener-v2-watchdog', name: 'Screener Callback Watchdog', schedule: manifestRepeatingWindow('screener-v2-watchdog').label, cron: manifestRepeatingWindow('screener-v2-watchdog').cron, group: 'pipeline_chain', chainIndex: 7 },
  { id: 'strategy-learning-watchdog', name: 'Strategy Learning Recovery Watchdog', schedule: 'Inside Screener Callback Watchdog', cron: '', group: 'pipeline_chain', chainIndex: 24 },
  { id: 'allocator-ev-readiness', name: 'Allocation Readiness', schedule: 'After screener + regime', cron: '', group: 'pipeline_chain', chainIndex: 8 },
  { id: 'pipeline', name: 'Pipeline', schedule: 'After allocation readiness', cron: '', group: 'pipeline_chain', chainIndex: 9 },
  { id: 'ml-predict', name: 'ML Predict', schedule: 'Inside pipeline', cron: '', group: 'pipeline_chain', chainIndex: 11 },
  { id: 'recommendation', name: 'Daily Recommendation', schedule: 'Inside pipeline', cron: '', group: 'pipeline_chain', chainIndex: 12 },
  { id: 'postclose-research-dispatch', name: 'Post-close Research Dispatch', schedule: 'Trading days 14:20', cron: '20 6 * * 1-5', group: 'pipeline_chain', chainIndex: 13 },
  { id: 'post-pipeline-chain', name: 'Post Pipeline Callback', schedule: 'After the 14:20 post-close dispatch', cron: '', group: 'pipeline_chain', chainIndex: 13 },
  { id: 'dataset-snapshot-export', name: 'Research Dataset Snapshot', schedule: 'Inside the 14:20 post-close research job', cron: '', group: 'pipeline_chain', chainIndex: 14 },
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
  { id: 'premarket-evidence-watchdog', name: 'Premarket Evidence Recovery', schedule: 'Mon-Fri 07:00-08:50', cron: '*/10 7-8 * * 1-5', timeZone: 'Asia/Taipei', group: 'daily' },
  { id: 'daily-snapshot', name: 'Daily Snapshot', schedule: 'Weekdays 14:20 + 18:25 settle', cron: '20 6 * * 1-5', group: 'daily' },
  { id: 'daily-execution-paper-lineage', name: 'Daily Execution/Paper Lineage', schedule: 'Weekdays 14:35, 14:50, 18:35, 18:50', cron: '35,50 6,10 * * 1-5', group: 'daily' },
  { id: 'external-evidence', name: 'External Evidence', schedule: 'Weekdays 23:15', cron: '15 15 * * 1-5', group: 'daily' },
  { id: 'debate-memory-retention', name: 'Debate Memory Retention', schedule: 'Daily 03:00', cron: '0 19 * * *', group: 'daily' },
  { id: 'artifact-reconcile', name: 'Artifact Reconcile', schedule: 'Daily 02:05', cron: '5 18 * * *', group: 'daily' },
  { id: 'retention-archive-only', name: 'Retention Archive Only', schedule: '02:37–06:52 every 15 min', cron: '37,52 18-22 * * *', group: 'daily' },
  { id: 'retention-hot-window-drain', name: 'Retention Hot Window Drain Preflight', schedule: 'Daily 02:35', cron: '35 18 * * *', group: 'daily' },
  { id: 'data-domain-shadow-backfill-next', name: 'Multi-D1 Sequential Backfill', schedule: 'Daily 00:30', cron: '30 16 * * *', group: 'daily' },
  { id: 'data-domain-shadow-backfill', name: 'Multi-D1 Backfill Workers', schedule: 'Paused paper backfill watchdog', cron: '', group: 'daily' },
  { id: 'legacy-strategy-evidence-migration', name: 'Legacy Strategy Evidence Migration', schedule: 'Daily 01:50??5:50 hourly', cron: '50 17-21 * * *', group: 'daily' },
  { id: 'legacy-hot-data-retirement', name: 'Legacy Hot Data Retirement', schedule: 'Daily 01:10??5:10 hourly', cron: '10 17-21 * * *', group: 'daily' },
  { id: 'r2-retention-sweep', name: 'R2 Retention Sweep', schedule: 'Daily 02:40', cron: '40 18 * * *', group: 'daily' },
  { id: 'audit-json-retention', name: 'Audit JSON Retention', schedule: 'Daily 01:00-06:45 / 15m', cron: '*/15 17-22 * * *', group: 'daily' },
  { id: 'orphan-reachability-gc', name: 'Orphan Reachability GC', schedule: 'Daily 03:00', cron: '0 19 * * *', group: 'daily' },
  { id: 'storage-health-check', name: 'Storage Health Check', schedule: 'Daily 06:45', cron: '45 22 * * *', group: 'daily' },
  { id: 'learning-retention-readiness', name: 'Learning Ten-Year Retention Readiness', schedule: 'Daily 02:20', cron: '20 18 * * *', group: 'daily' },
  { id: 'legacy-learning-deletion-readiness', name: 'Legacy Learning Deletion Readiness', schedule: 'Daily 06:50', cron: '50 22 * * *', group: 'daily' },
  { id: 'storage-integrity-audit', name: 'Storage Integrity Audit', schedule: 'Sunday 03:30', cron: '30 19 * * 6', group: 'weekly' },

  { id: 'intraday-check', name: 'Intraday Check', schedule: 'Mon-Fri 09:00-13:30 per-min', cron: '* 1-4 * * 1-5 + 0-30 5 * * 1-5', group: 'intraday' },
  { id: 'paired-native-execution', name: 'Paired Native Shadow Execution（已停用）', schedule: 'PAUSED · single B; history retained', cron: '15-59 23 * * SUN-THU + * 0-6 * * 1-5', group: 'intraday' },
  { id: 'strategy-nav-execution', name: '策略 NAV 獨立比較（已停用）', schedule: 'RETIRED · R33 Phase 1; history retained', cron: '15-59 23 * * SUN-THU + * 0-6 * * 1-5', group: 'intraday' },
  { id: 'rescore-10', name: 'Intraday Re-score 10:00', schedule: 'Weekdays 10:00', cron: '0 2 * * 1-5', group: 'intraday' },
  { id: 'rescore-11', name: 'Intraday Re-score 11:00', schedule: 'Weekdays 11:00', cron: '0 3 * * 1-5', group: 'intraday' },
  { id: 'rescore-12', name: 'Intraday Re-score 12:00', schedule: 'Weekdays 12:00', cron: '0 4 * * 1-5', group: 'intraday' },
  { id: 'rescore-1230', name: 'Intraday Re-score 12:30', schedule: 'Weekdays 12:30', cron: '30 4 * * 1-5', group: 'intraday' },
  { id: 'eod-exit', name: 'EOD Exit', schedule: `Weekdays ${eodExitSchedule().twTime}`, cron: eodExitSchedule().cron, group: 'intraday' },
  { id: 'post-close-price-refresh', name: 'Post-close Price Refresh', schedule: 'Weekdays 13:40', cron: '40 5 * * 1-5', group: 'intraday' },

  { id: 'weekly-audit', name: 'Weekly Audit', schedule: 'Friday 18:30', cron: '30 10 * * 5', group: 'weekly' },
  { id: 'weekly-readiness', name: 'Weekly Readiness', schedule: 'Sunday 12:00', cron: '0 12 * * 0 taipei', group: 'weekly' },
  { id: 'weekly-cleanup', name: 'Weekly Cleanup', schedule: 'Sunday 04:00 (no retrain)', cron: '0 20 * * 6', group: 'weekly' },
  { id: 'weekly-backtest', name: 'Weekly Validation/MC', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'alpha-quality', name: 'Alpha Quality', schedule: 'Sunday 06:00', cron: '0 22 * * 6', group: 'weekly' },
  { id: 'weekly-optuna', name: 'Weekly Optuna', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },
  { id: 'adaptive-meta-policy-replay', name: 'Adaptive Meta Policy Replay', schedule: 'Sunday 06:40', cron: '40 22 * * 6', group: 'weekly' },
  { id: 's12-smcvwap-calibration', name: 'S12 SMC/VWAP Calibration', schedule: 'Sunday 06:45 (monthly cadence after first Sat)', cron: '45 22 * * 6', group: 'weekly' },
  { id: 'linucb-multiplier-replay', name: 'LinUCB Multiplier Replay', schedule: 'Sunday 06:50', cron: '50 22 * * 6', group: 'weekly' },
  { id: 'active8-oof-weekly', name: 'Active-8 OOF Weekly Cohort', schedule: 'Sunday 07:05', cron: '5 23 * * 6', group: 'weekly' },
  { id: 'weekly-drift-retrain', name: 'Weekly Drift Candidate', schedule: 'Manual, approval-gated shadow candidate', cron: '', group: 'weekly' },

  { id: 'sector-leaders', name: 'Sector Leaders', schedule: 'Sunday 06:30', cron: '30 22 * * 6', group: 'weekly' },
  { id: 'monthly-optuna', name: 'Monthly Optuna', schedule: 'First Sat 16:00', cron: 'first saturday of month 16:00 taipei', group: 'monthly' },
  { id: 'active8-oof-monthly', name: 'Active-8 Monthly Release Train', schedule: 'First Sunday 02:00', cron: 'first sunday of month 02:00 taipei', group: 'monthly' },

  { id: 'monthly-strategy-mining', name: 'Monthly Strategy Mining', schedule: 'First Sat 10:00', cron: 'first saturday of month 10:00 taipei', group: 'monthly' },
  { id: 'monthly-readiness', name: 'Monthly Readiness', schedule: 'First Sunday 12:30', cron: 'first sunday of month 12:30 taipei', group: 'monthly' },
  { id: 'storage-capacity-report', name: 'Storage Capacity Report', schedule: 'Daily 06:55', cron: '55 22 * * *', group: 'daily' },

  { id: 'optuna-queue', name: 'Optuna Queue Processor', schedule: 'Every 6h', cron: '0 */6 * * *', group: 'daily' },
]

type SchedulerManifestJob = { id: string; task: string; schedule: string }
const SCHEDULER_MANIFEST_JOBS = (schedulerManifest as { jobs: SchedulerManifestJob[] }).jobs

function canonicalCronFor(def: JobDef): string {
  // UI rows represent logical trading slots even when one physical timer serves three.
  if (/^rescore-(10|11|12|1230)$/.test(def.id)) return def.cron
  const exact = SCHEDULER_MANIFEST_JOBS.filter((job) => job.id === def.id)
  const taskOwned = SCHEDULER_MANIFEST_JOBS.filter((job) => job.task === def.id)
  const owned = taskOwned.length > 0 ? taskOwned : exact
  return owned.length > 0
    ? [...new Set(owned.map((job) => job.schedule))].join(' + ')
    : def.cron
}

const JOB_DEFS: JobDef[] = JOB_DEF_METADATA.map((def) => ({
  ...def,
  cron: canonicalCronFor(def),
}))

export const SCHEDULER_STATUS_JOB_DEFS = JOB_DEFS

export const CHAIN_STEP_IDS = [
  'market-close-refresh',
  'evening-chain',
  'finlab-v4-backfill',
  'update',
  'indicator-queue',
  'regime-compute',
  'strategy-learning-mature-evidence',
  'screener',
  'allocator-ev-readiness',
  'pipeline',
  'ml-predict',
  'recommendation',
  'post-pipeline-chain',
  'allocator-ev-feature-snapshot-backfill',
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
export const DURABLE_EVENT_TASK_IDS = new Set(['dataset-snapshot-export', 'active8-oof-daily'])
const SCHEDULER_STATUS_SCAN_DAYS = 7
const SCHEDULER_STATUS_LEGACY_FALLBACK_DAYS = 2
// Today and yesterday still change and the daily aggregate is a best-effort read-modify-write, so a displayed
// job it lacks, or still holds as non-terminal, is filled from its per-task key (display only, bounded).
const SCHEDULER_STATUS_DIRECT_READ_DAYS = 2
const SCHEDULER_STATUS_DIRECT_READ_LIMIT = 30
const SCHEDULER_STATUS_NON_TERMINAL = new Set(['running', 'triggered', 'waiting'])

export function estimateSchedulerStatusKvReads(): number {
  // + today's holiday marker and canonical keys for idle scheduled watchdogs
  const watchdogs = JOB_DEFS.filter((def) => def.id.endsWith('-watchdog') && watchdogWindowOpenTwMinute(def) != null).length
  return SCHEDULER_STATUS_SCAN_DAYS * 2 + CHAIN_STEP_IDS.filter((task) => task !== 'evening-chain').length + 3 + watchdogs
    + SCHEDULER_STATUS_DIRECT_READ_LIMIT
}

export interface SchedulerDisplayLogCandidate {
  date: string
  log?: CronLogEntry
}

export function selectSchedulerChainDates(
  dates: string[],
  logsByDate: Record<string, CronLogEntry[]>,
): {
  activeChainDate: string | null
  chainStatusDate: string | null
} {
  const rootForDate = (date: string) => logsByDate[date]?.find((entry) => entry.task === 'evening-chain')
  const chainStatusDate = dates.find((date) => {
    const root = rootForDate(date)
    return root?.status === 'running'
      || root?.status === 'triggered'
      || root?.status === 'success'
      || root?.status === 'error'
  }) ?? null
  const latestRoot = chainStatusDate ? rootForDate(chainStatusDate) : undefined
  const activeChainDate = latestRoot?.status === 'running' || latestRoot?.status === 'triggered'
    ? chainStatusDate
    : null

  return {
    activeChainDate,
    // Dates are newest-first. An older stale running head must never override
    // a newer terminal chain, while a newer active attempt still takes over.
    chainStatusDate,
  }
}

export function selectSchedulerChainDisplayDate(input: {
  today: string
  activeChainDate: string | null
  chainStatusDate: string | null
  logsByDate: Record<string, CronLogEntry[]>
}): string | null {
  if (input.activeChainDate) return input.activeChainDate
  const todayHasLiveChainActivity = (input.logsByDate[input.today] ?? []).some((entry) => (
    CHAIN_STEP_IDS.includes(entry.task)
    && String(entry.run_date ?? input.today) === input.today
    && ['running', 'triggered', 'success', 'error'].includes(entry.status)
  ))
  return todayHasLiveChainActivity ? input.today : input.chainStatusDate
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

export function inferShortRunConcern(def: JobDef, log?: CronLogEntry): {
  durationConcern: SchedulerDurationConcern
  durationConcernReason?: string
} {
  if (!log || log.duration_ms == null || log.duration_ms >= 2000) return { durationConcern: null }

  const summary = `${log.summary ?? ''} ${log.error ?? ''}`.toLowerCase()
  const status = log.status
  // A run id in the text does not make a no-op receipt a real success.
  if (status === 'success' && /^\s*skip/.test(summary)) {
    return {
      durationConcern: 'suspicious_short',
      durationConcernReason: 'success receipt describes a skipped no-op',
    }
  }
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

export function getSchedulerScanDates(anchorDate?: string): string[] {
  const dates: string[] = []
  const normalizedAnchor = String(anchorDate ?? '').trim()
  const now = /^\d{4}-\d{2}-\d{2}$/.test(normalizedAnchor)
    ? new Date(`${normalizedAnchor}T00:00:00.000Z`)
    : new Date(Date.now() + 8 * 3600_000)
  for (let i = 0; i < SCHEDULER_STATUS_SCAN_DAYS; i += 1) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

export type DurablePipelineStageDisplayRow = {
  business_date: string
  stage: 'pipeline_execution' | 'post_pipeline_chain' | 'verify_v2' | 'post_verify_chain'
  canonical_run_id: string
  status: 'queued' | 'running' | 'waiting' | 'success' | 'error'
  attempt_count: number
  queued_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  updated_at: string
  last_error: string | null
}

export const DURABLE_STAGE_JOB_IDS: Record<DurablePipelineStageDisplayRow['stage'], string> = {
  pipeline_execution: 'pipeline',
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
  baseDispatchRunId?: string | null
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
  // A later watchdog/readback may touch the durable row after the scheduler KV
  // already recorded success. Keep the original completion timestamp in that
  // case; durable state is recovery authority, not a second execution time.
  if (baseStatus === 'success' && durable.status === 'success') return null

  const durableTimestamp = sqliteUtcTimestamp(durable.updated_at)
  const durableMs = Date.parse(durableTimestamp)
  const baseMs = baseTimestamp ? Date.parse(baseTimestamp) : Number.NEGATIVE_INFINITY
  // A trigger acknowledgement can arrive after the durable enqueue write
  // (SQLite seconds vs KV milliseconds). It cannot promote queued to running.
  const sameRunDispatch = Boolean(input.baseDispatchRunId && input.baseDispatchRunId === durable.canonical_run_id)
  if (!Number.isFinite(durableMs) || (!sameRunDispatch && Number.isFinite(baseMs) && durableMs <= baseMs)) return null

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

export function reconcileSchedulerExecutionTicketStatus(input: {
  baseStatus: SchedulerLastStatus
  baseTimestamp?: string | null
  ticket?: SchedulerExecutionTicketRow
  expectedRunDate?: string | null
}): {
  lastStatus: SchedulerLastStatus
  lastRunAt: string
  summary: string
  lastError?: string
  statusAuthority: 'scheduler_execution_ticket'
  runId: string
  attemptId: string
  attemptCount: number
  ticketId: string
} | null {
  const { ticket } = input
  if (!ticket) return null
  if (input.expectedRunDate && ticket.business_date !== input.expectedRunDate) return null
  const ticketTimestamp = sqliteUtcTimestamp(ticket.updated_at)
  const ticketMs = Date.parse(ticketTimestamp)
  const baseMs = input.baseTimestamp ? Date.parse(input.baseTimestamp) : Number.NEGATIVE_INFINITY
  const closureDefect = schedulerTicketClosureDefect(ticket)
  if (!Number.isFinite(ticketMs) || (!closureDefect && Number.isFinite(baseMs) && ticketMs < baseMs)) return null
  const lastStatus: SchedulerLastStatus = closureDefect ? 'failed' : ticket.status === 'success'
    ? 'success'
    : ticket.status === 'blocked' ? 'blocked'
    : ticket.status === 'error'
      ? 'failed'
      : ticket.status === 'skipped'
        ? 'skip'
        : 'running'
  return {
    lastStatus,
    lastRunAt: ticketTimestamp,
    summary: closureDefect
      ? `${closureDefect}; historical record is not current-cycle completion; ${ticket.last_summary ?? ''}`
      : ticket.last_summary || `${ticket.status}; durable scheduler execution ticket`,
    lastError: closureDefect || (['failed','blocked'].includes(lastStatus) ? (ticket.last_error || ticket.last_summary || undefined) : undefined),
    statusAuthority: 'scheduler_execution_ticket',
    runId: ticket.run_id,
    attemptId: ticket.attempt_id,
    attemptCount: ticket.attempt_count,
    ticketId: ticket.ticket_id,
  }
}

export function selectSchedulerExecutionTicketForDisplay<T>(input: {
  exactTaskTicket?: T
  exactJobTicket?: T
  latestTaskTicket?: T
  physicalRoot: boolean
  scopedRunDate?: string | null
}): T | undefined {
  return input.exactTaskTicket
    ?? input.exactJobTicket
    ?? (input.physicalRoot || input.scopedRunDate ? undefined : input.latestTaskTicket)
}

type DurableEventTicketEvidence = Pick<
  SchedulerExecutionTicketRow,
  'status' | 'business_date' | 'updated_at'
>

export function resolveDurableEventDisplay(input: {
  jobId: string
  today: string
  baseTimestamp?: string | null
  ticket?: DurableEventTicketEvidence
}): SchedulerDisplayStatus | null {
  if (!DURABLE_EVENT_TASK_IDS.has(input.jobId) || !input.ticket) return null
  const ticketTimestamp = sqliteUtcTimestamp(input.ticket.updated_at)
  const ticketMs = Date.parse(ticketTimestamp)
  const baseMs = input.baseTimestamp ? Date.parse(input.baseTimestamp) : Number.NEGATIVE_INFINITY
  if (!Number.isFinite(ticketMs) || (Number.isFinite(baseMs) && ticketMs <= baseMs)) return null

  const status: SchedulerLastStatus = input.ticket.status === 'success'
    ? 'success'
    : input.ticket.status === 'blocked' ? 'blocked'
    : input.ticket.status === 'error'
      ? 'failed'
      : input.ticket.status === 'skipped'
        ? 'skip'
        : 'running'
  return {
    status,
    statusScope: input.ticket.business_date === input.today ? 'today' : 'durable_event',
    statusRunDate: input.ticket.business_date,
  }
}

async function loadDurablePipelineStageStates(
  db: D1Database,
  dates: string[],
): Promise<Map<string, DurablePipelineStageDisplayRow>> {
  const placeholders = dates.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT business_date, stage, canonical_run_id, status, attempt_count,
           queued_at, started_at, completed_at, updated_at, last_error
      FROM pipeline_stage_runs
     WHERE business_date IN (${placeholders})
       AND stage IN ('pipeline_execution', 'post_pipeline_chain', 'verify_v2', 'post_verify_chain')
  `).bind(...dates).all<DurablePipelineStageDisplayRow>()
  return new Map((result.results ?? []).map((row) => [
    `${row.business_date}:${DURABLE_STAGE_JOB_IDS[row.stage]}`,
    row,
  ]))
}

export type SchedulerRunDisplayTime = {
  timestamp: string | null
  basis: 'started' | 'updated'
}

const CALLBACK_CONTAINER_JOB_IDS = new Set(['pipeline', 'post-pipeline-chain', 'post-verify-chain'])

export function resolveSchedulerRunDisplayTime(input: {
  jobId: string
  displayTimestamp?: string | null
  durable?: DurablePipelineStageDisplayRow
}): SchedulerRunDisplayTime {
  const durableStartedAt = sqliteUtcTimestamp(input.durable?.started_at ?? '')
  if (CALLBACK_CONTAINER_JOB_IDS.has(input.jobId) && durableStartedAt) {
    return { timestamp: durableStartedAt, basis: 'started' }
  }
  return { timestamp: input.displayTimestamp ?? null, basis: 'updated' }
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


export function inferPipelineChildLog(logs: CronLogEntry[] | undefined, taskId: string): CronLogEntry | undefined {
  if (!PIPELINE_CHILD_TASKS.has(taskId)) return undefined
  const pipelineLog = logs?.find((entry) => entry.task === 'pipeline')
  if (!pipelineLog || pipelineLog.status === 'skipped') return undefined
  const summary = pipelineLog.summary ?? ''
  const terminal = pipelineLog.status === 'success' || pipelineLog.status === 'error'
  const count = taskId === 'ml-predict'
    ? summary.match(/ml-predict(?:-v2)?\((\d+)\s+predictions\)/i)
      ?? summary.match(/\b(?:predictions(?:_written)?|preds)[=:]\s*(\d+)/i)
    : summary.match(/\b(?:recommendations?_updated|recos_updated|recos)[=:]\s*(\d+)/i)

  // Parent activity, input preparation and parent failure are not evidence
  // that either child started. Prefer each child's own callback receipt.
  if (terminal) {
    if (pipelineLog.status !== 'success' || !count || Number(count[1]) <= 0) return undefined
    return {
      ...pipelineLog,
      task: taskId,
      run_scope: 'derived',
      summary: `derived from pipeline: ${count[1]} ${taskId === 'ml-predict' ? 'predictions' : 'recommendations'}; duration is parent elapsed time`,
      error: undefined,
    }
  }
  const activity = taskId === 'ml-predict'
    ? /\bmodal_prediction=(?:triggered|running|spawned)\b/i.test(summary)
    : /\brecommendation_status=(?:triggered|running)\b/i.test(summary)
  if (!activity) return undefined
  return { ...pipelineLog, task: taskId, run_scope: 'derived', status: 'running',
    summary: `derived from pipeline: ${taskId} started; duration is parent elapsed time`, error: undefined }
}

function formatTimestamp(ts: string): string {
  if (!ts) return 'N/A'
  try {
    const d = new Date(Date.parse(ts) + 8 * 3600_000)
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
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
  // The input is already a Taiwan calendar date, not a UTC instant.
  const d = new Date(`${date}T00:00:00.000Z`)
  const day = d.getUTCDay()
  return day >= 1 && day <= 5
}

function runningSlaMs(def?: Pick<JobDef, 'id' | 'group'>): number {
  if (!def) return 60 * 60_000
  if (def.id === 'active8-oof-monthly') return 8 * 60 * 60_000
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

// Once serving is published the root stays running, by design, until the next weekday's 14:20 after-close dispatch.
const AFTER_CLOSE_WAIT_SUMMARY = /research waits for the after-close dispatch/
function afterCloseWaitDeadlineMs(runDate: string): number {
  const dispatch = new Date(`${runDate}T06:20:00.000Z`)
  do dispatch.setUTCDate(dispatch.getUTCDate() + 1); while (!isWeekdayTw(dispatch.toISOString().slice(0, 10)))
  return dispatch.getTime() + runningSlaMs({ id: 'evening-chain', group: 'pipeline_chain' })
}

export function resolveSchedulerLogStatus(
  log?: CronLogEntry,
  def?: Pick<JobDef, 'id' | 'group'>,
  nowMs = Date.now(),
): SchedulerResolvedStatus {
  if (!log) return { status: null, staleRunning: false }
  if (def?.id === 'active8-oof-daily' && ['triggered', 'skipped'].includes(log.status)
    && /reason=awaiting_(premarket|pipeline) job_dispatched=false/.test(log.summary ?? '')) {
    return { status: 'waiting', staleRunning: false }
  }
  if (log.status === 'waiting') return { status: 'waiting', staleRunning: false }
  // Older watchdog receipts logged a no-op as success; read them as the skip they were.
  if (def?.id === 'strategy-learning-watchdog' && log.status === 'success' && /^SKIPPED /.test(log.summary ?? '')) {
    return { status: 'skip', staleRunning: false }
  }
  if (log.status === 'success') return { status: 'success', staleRunning: false }
  if (log.status === 'blocked') return { status: 'blocked', staleRunning: false }
  // Read old callbacks correctly without rewriting their historical evidence.
  if (def?.id === 'update' && log.status === 'error' && log.duration_ms === 0
    && log.summary?.startsWith('FinLab canonical backfill blocked market data continuation:')) {
    return { status: 'blocked', staleRunning: false }
  }
  if (log.status === 'error') return { status: 'failed', staleRunning: false }
  if (log.status === 'skipped') return { status: 'skip', staleRunning: false }
  if (log.status === 'triggered' || log.status === 'running') {
    // Parked on a scheduled dispatch: waiting until then, and the stall SLA starts at the dispatch.
    const waitUntilMs = parseLogTime(log.wait_until)
    if (waitUntilMs != null && nowMs < waitUntilMs) return { status: 'waiting', staleRunning: false }
    const ageMs = logAgeMs(
      waitUntilMs != null && waitUntilMs > (parseLogTime(log.timestamp) ?? 0) ? { ...log, timestamp: log.wait_until! } : log,
      nowMs,
    )
    const slaMs = runningSlaMs(def)
    const runDate = log.run_date || timestampTwDate(log.timestamp)
    if (def?.id === 'evening-chain' && log.status === 'running' && AFTER_CLOSE_WAIT_SUMMARY.test(log.summary ?? '')
      && runDate && ageMs != null && ageMs > slaMs && nowMs <= afterCloseWaitDeadlineMs(runDate)) {
      return { status: 'waiting', staleRunning: false }
    }
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

/** A skip that stands in for work which should have run for real; never a neutral no-op. */
export function schedulerSkipAttentionReason(log?: CronLogEntry): string | null {
  const summary = log?.summary ?? ''
  const replay = /non-production-authoritative callback run_date=(\d{4}-\d{2}-\d{2}); \S+ is live-canonical only/.exec(summary)
  if (replay) return `live-canonical task did not run: run_date=${replay[1]} only reached it as a historical replay`
  if (log?.task === 'strategy-learning-watchdog' && summary.includes('recoverable_run_missing')) {
    return 'no strategy-learning run found in the recovery lookback'
  }
  return null
}

function triggeredDispatchRunId(log?: CronLogEntry): string | null | undefined {
  return log?.status === 'triggered'
    ? log.run_id ?? /(?:^|\s)run_id=([^,\s;]+)/.exec(log.summary ?? '')?.[1] : null
}

export type SchedulerHistoryCell =
  | 'success' | 'failed' | 'running' | 'triggered' | 'waiting' | 'blocked' | 'attention' | 'missing' | 'skip' | 'none'
// Cells where a run was due: SLO counts them; in-flight, no-op and no-receipt cells are not judged yet.
const SLO_COUNTED_CELLS = new Set<SchedulerHistoryCell>(['success', 'failed', 'blocked', 'attention', 'missing'])

/** One run_date of the 7d strip. Durable stage state outranks KV, as in the row display. */
export function resolveSchedulerHistoryCell(input: {
  def: Pick<JobDef, 'id' | 'group'>
  date: string
  log?: CronLogEntry
  rootLog?: CronLogEntry
  durable?: DurablePipelineStageDisplayRow
  nowMs?: number
}): { cell: SchedulerHistoryCell; evidenceAt: string | null; stuck: boolean } {
  const { def, date, log, nowMs = Date.now() } = input
  const resolved = resolveSchedulerLogStatus(log, def, nowMs)
  const durable = reconcileDurablePipelineStageStatus({
    jobId: def.id,
    runDate: date,
    baseStatus: resolved.status ?? 'skip',
    baseTimestamp: log?.timestamp,
    baseDispatchRunId: triggeredDispatchRunId(log),
    durable: input.durable,
  })
  if (durable) {
    const cell = durable.lastStatus === 'success' || durable.lastStatus === 'failed' || durable.lastStatus === 'waiting'
      ? durable.lastStatus : 'running'
    return { cell, evidenceAt: durable.lastRunAt, stuck: false }
  }
  const evidenceAt = log?.timestamp || null
  switch (resolved.status) {
    case 'failed': return { cell: 'failed', evidenceAt, stuck: resolved.staleRunning }
    case 'running': return { cell: log?.status === 'triggered' ? 'triggered' : 'running', evidenceAt, stuck: false }
    case 'skip': return { cell: schedulerSkipAttentionReason(log) ? 'attention' : 'skip', evidenceAt, stuck: false }
    case 'success': case 'waiting': case 'blocked': return { cell: resolved.status, evidenceAt, stuck: false }
  }
  // A chain step with no receipt on a date whose root really ended (success, or a recorded error) never ran.
  // A stuck or waiting root has not ended, so its later steps are not judged yet.
  const root = resolveSchedulerLogStatus(input.rootLog, { id: 'evening-chain', group: 'pipeline_chain' }, nowMs)
  const due = def.id !== 'evening-chain' && CHAIN_STEP_IDS.includes(def.id)
    && (root.status === 'success' || (root.status === 'failed' && !root.staleRunning))
  return { cell: due ? 'missing' : 'none', evidenceAt: null, stuck: false }
}

// Read for the status page only; the PR-base aggregate read (and so the deploy gate's failed24h) never saw them.
const GATE_UNREAD_TASKS = new Set(['finlab-backfill-watchdog'])

type IdleJobDef = Pick<JobDef, 'id' | 'group' | 'chainIndex'> & Partial<Pick<JobDef, 'cron' | 'timeZone'>>

// The trigger route writes a receipt (or ticket) on every tick, including no-ops and holiday skips.
// One sync attempt (up to 10m) plus a missed tick may pass before the first receipt lands.
const WATCHDOG_FIRST_RECEIPT_GRACE_MS = 20 * 60_000

const CRON_DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** Values of one cron field (`*`, `*\/N`, `a`, `a-b`, `a-b/N`, lists, day names); null when it cannot be read. */
function cronFieldValues(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|[0-9A-Z]+(?:-[0-9A-Z]+)?)(?:\/(\d+))?$/.exec(part.toUpperCase())
    if (!match) return null
    const parse = (token: string) => (/^\d+$/.test(token) ? Number(token) : CRON_DOW_NAMES.indexOf(token))
    const [from, to] = match[1] === '*' ? [min, max] : match[1].split('-').map(parse)
    const end = to ?? (match[2] ? max : from)
    const step = Number(match[2] ?? 1)
    if (!Number.isInteger(from) || !Number.isInteger(end) || from < min || end > max || from > end || step < 1) return null
    for (let value = from; value <= end; value += step) values.add(value === 7 && max === 7 ? 0 : value)
  }
  return [...values]
}

/**
 * Earliest Taiwan-time instant on this Taiwan date at which the job's cron fires; null when it does not fire
 * that day or its cron cannot be read (event-driven, monthly phrases, day-of-month fields).
 */
export function firstScheduledRunMsOnTwDate(def: Pick<JobDef, 'cron' | 'timeZone'>, twDate: string): number | null {
  const twMidnightMs = Date.parse(`${twDate}T00:00:00.000Z`) - 8 * 3600_000
  let first: number | null = null
  for (const expression of (def.cron ?? '').split(' + ')) {
    const fields = expression.trim().split(/\s+/)
    const taipei = def.timeZone === 'Asia/Taipei' || fields.at(-1) === 'taipei'
    if (fields.at(-1) === 'taipei') fields.pop()
    if (fields.length !== 5 || fields[2] !== '*' || fields[3] !== '*') return null
    const minutes = cronFieldValues(fields[0], 0, 59)
    const hours = cronFieldValues(fields[1], 0, 23)
    const days = cronFieldValues(fields[4], 0, 7)
    if (!minutes?.length || !hours?.length || !days) return null
    // A UTC cron day overlaps the Taiwan date on that date and on the day before it.
    for (const dayShift of taipei ? [0] : [-1, 0]) {
      const cronDay = new Date(Date.parse(`${twDate}T00:00:00.000Z`) + dayShift * 86400_000)
      if (!days.includes(cronDay.getUTCDay())) continue
      for (const hour of hours) {
        const fireMs = cronDay.getTime() + (hour * 60 + Math.min(...minutes)) * 60_000 - (taipei ? 8 * 3600_000 : 0)
        if (fireMs >= twMidnightMs && fireMs < twMidnightMs + 86400_000 && (first == null || fireMs < first)) first = fireMs
      }
    }
  }
  return first
}

/** Minute of the Taiwan day when a weekday repeating window (`*\/N H-H * * 1-5`) opens; null when it cannot be read. */
export function watchdogWindowOpenTwMinute(def: IdleJobDef): number | null {
  const match = /^\*\/\d{1,2} (\d{1,2})-\d{1,2} \* \* 1-5$/.exec(def.cron ?? '')
  if (!match) return null
  const minute = Number(match[1]) * 60 + (def.timeZone === 'Asia/Taipei' ? 0 : 8 * 60)
  // A UTC window opening after Taiwan midnight would fall on the next Taiwan weekday; no watchdog has one.
  return minute < 1440 ? minute : null
}

/** When a scheduled watchdog's window opens on this Taiwan weekday; null on a weekend or without a window of its own. */
function watchdogWindowOpenMs(def: IdleJobDef, today: string): number | null {
  if (!def.id.endsWith('-watchdog') || !isWeekdayTw(today)) return null
  const openMinute = watchdogWindowOpenTwMinute(def)
  return openMinute == null ? null : Date.parse(`${today}T00:00:00.000Z`) + (openMinute - 8 * 60) * 60_000
}

/** Once today's window is open a watchdog owes a receipt from inside it: waiting through the grace, then missed. */
function watchdogWindowGap(
  def: IdleJobDef, today: string, nowMs: number, holiday: boolean, todayLog?: CronLogEntry,
): SchedulerDisplayStatus | null {
  const openMs = watchdogWindowOpenMs(def, today)
  if (openMs == null || holiday || nowMs < openMs) return null
  // Ticks after midnight of last night's window land on today's key; they say nothing about tonight's window.
  if ((parseLogTime(todayLog?.timestamp) ?? Number.NEGATIVE_INFINITY) >= openMs) return null
  const openedAt = new Date(openMs).toISOString()
  if (nowMs < openMs + WATCHDOG_FIRST_RECEIPT_GRACE_MS) {
    return { status: 'waiting', statusScope: 'schedule', statusRunDate: null, windowOpenedAt: openedAt }
  }
  return {
    status: 'failed',
    statusScope: 'today',
    statusRunDate: today,
    staleReason: `missed: no ${today} receipt since its window opened at ${new Date(openMs + 8 * 3600_000).toISOString().slice(11, 16)} TW`,
    windowOpenedAt: openedAt,
  }
}

function inferIdleStatus(def: Pick<JobDef, 'id' | 'group' | 'chainIndex'>, nextRun: string, today: string): SchedulerLastStatus {
  // Outside its open window a watchdog acts only when its owner stalls; nothing is pending on it.
  if (def.id.endsWith('-watchdog')) return 'sleep'
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
  cadenceCycleLog?: CronLogEntry
  activeReplayLog?: CronLogEntry
  activeReplayRunDate?: string | null
  activeReplayHeartbeatAt?: string | null
  activeReplayClosureAt?: string | null
  activeReplayIsRunning?: boolean
  def: IdleJobDef
  nextRun: string
  today: string
  /** `holiday:<today>` is set: an idle watchdog is out of window. */
  holiday?: boolean
  /** false replays the PR-base reading (no watchdog window judgment) for the deploy gate. */
  windowGap?: boolean
  nowMs?: number
}): SchedulerDisplayStatus {
  const {
    todayLog,
    lastAttempt,
    cadenceCycleLog,
    activeReplayLog,
    activeReplayRunDate,
    activeReplayHeartbeatAt,
    activeReplayClosureAt,
    activeReplayIsRunning = false,
    def,
    nextRun,
    today,
    nowMs = Date.now(),
  } = input
  const windowGap = input.windowGap === false ? null : watchdogWindowGap(def, today, nowMs, input.holiday ?? false, todayLog)
  if (windowGap) return windowGap
  const activeRunDate = String(activeReplayRunDate ?? '').trim()
  const activeLogRunDate = String(activeReplayLog?.run_date ?? '').trim()
  const replayObservedToday = timestampTwDate(activeReplayLog?.timestamp) === today
  const rootHeartbeatObservedToday = def.id === 'evening-chain' && timestampTwDate(activeReplayHeartbeatAt ?? undefined) === today
  const replayClosureObservedToday = timestampTwDate(activeReplayClosureAt ?? undefined) === today
  const hasActiveReplayLog = Boolean(
    activeRunDate
    && activeRunDate !== today
    && activeLogRunDate === activeRunDate
    && (activeReplayIsRunning || replayObservedToday || rootHeartbeatObservedToday || replayClosureObservedToday),
  )
  const resolvedToday = resolveSchedulerLogStatus(todayLog, def, nowMs)
  if (resolvedToday.status && !hasActiveReplayLog) {
    return {
      status: resolvedToday.status,
      statusScope: 'today',
      statusRunDate: today,
      staleReason: resolvedToday.staleReason,
    }
  }

  if (!hasActiveReplayLog && cadenceCycleLog && (def.group === 'weekly' || def.group === 'monthly')) {
    const resolvedCycle = resolveSchedulerLogStatus(cadenceCycleLog, def, nowMs)
    if (resolvedCycle.status) {
      return {
        status: resolvedCycle.status,
        statusScope: 'cadence_cycle',
        statusRunDate: String(cadenceCycleLog.run_date || timestampTwDate(cadenceCycleLog.timestamp) || today),
        staleReason: resolvedCycle.staleReason,
      }
    }
  }

  const replayLog = hasActiveReplayLog ? activeReplayLog : lastAttempt
  const replayRunDate = String(replayLog?.run_date ?? '').trim()
  const replayLogTimestampMs = parseLogTime(replayLog?.timestamp)
  const heartbeatTimestampMs = parseLogTime(activeReplayHeartbeatAt ?? undefined)
  const replayStatusLog = hasActiveReplayLog
    && def.id === 'evening-chain'
    && replayLog
    && heartbeatTimestampMs != null
    && (replayLogTimestampMs == null || heartbeatTimestampMs > replayLogTimestampMs)
    ? { ...replayLog, timestamp: String(activeReplayHeartbeatAt) }
    : replayLog
  const isHistoricalReplay = Boolean(
    hasActiveReplayLog || (
      replayRunDate && replayRunDate !== today && timestampTwDate(replayLog?.timestamp) === today
    ),
  )
  if (isHistoricalReplay) {
    const resolvedReplay = resolveSchedulerLogStatus(replayStatusLog, def, nowMs)
    const runScope: SchedulerStatusScope = replayLog?.run_scope === 'live_canonical'
      ? 'today'
      : 'historical_replay'
    if (resolvedReplay.status) {
      return {
        status: resolvedReplay.status,
        statusScope: runScope,
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

export function resolveBusinessDateScopedChainDisplay(input: {
  def: Pick<JobDef, 'id' | 'group' | 'chainIndex'>
  chainStatusDate: string | null
  today: string
  exactLog?: CronLogEntry
  /** Latest chain step log of this chain date; the root is alive while its steps keep writing. */
  heartbeatAt?: string
  nowMs?: number
}): { displayLog?: CronLogEntry; resolvedDisplay: SchedulerDisplayStatus } | null {
  const chainDate = String(input.chainStatusDate ?? '').trim()
  if (!chainDate || !CHAIN_STEP_IDS.includes(input.def.id)) return null

  const logRunDate = String(input.exactLog?.run_date ?? '').trim()
  const exactLog = input.exactLog && (!logRunDate || logRunDate === chainDate)
    ? input.exactLog
    : undefined
  if (!exactLog) {
    return {
      displayLog: undefined,
      resolvedDisplay: {
        status: 'waiting',
        statusScope: chainDate === input.today ? 'today' : 'historical_replay',
        statusRunDate: chainDate,
      },
    }
  }

  const heartbeatMs = input.def.id === 'evening-chain' ? parseLogTime(input.heartbeatAt) : null
  const statusLog = heartbeatMs != null && heartbeatMs > (parseLogTime(exactLog.timestamp) ?? 0)
    ? { ...exactLog, timestamp: String(input.heartbeatAt) }
    : exactLog
  const resolved = resolveSchedulerLogStatus(statusLog, input.def, input.nowMs)
  return {
    displayLog: exactLog,
    resolvedDisplay: {
      status: resolved.status ?? 'waiting',
      statusScope: exactLog.run_scope === 'live_canonical' || chainDate === input.today
        ? 'today'
        : 'historical_replay',
      statusRunDate: chainDate,
      staleReason: resolved.staleReason,
    },
  }
}

function startOfWeeklyCycle(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - mondayOffset)
  return date.toISOString().slice(0, 10)
}

function isCurrentCadenceCycle(date: string, today: string, group: JobDef['group']): boolean {
  if (group === 'weekly') return date >= startOfWeeklyCycle(today) && date <= today
  if (group === 'monthly') return date.slice(0, 7) === today.slice(0, 7) && date <= today
  return false
}

export async function getSchedulerStatus(env: Bindings, anchorDate?: string, nowMs = Date.now()) {
  const dates = getSchedulerScanDates(anchorDate)
  const displayDates = dates.slice(0, 7)
  const today = dates[0]

  const allLogs: Record<string, CronLogEntry[]> = {}
  const opsDb = databaseForDataDomain(env, 'ops')
  const premarketProgressPromise = loadPremarketProgress(opsDb, today).catch((error) => {
    console.warn('[schedulerStatus] premarket progress read failed:', error)
    return []
  })
  const finlabProgressPromise = opsDb.prepare(`SELECT business_date,cursor_key
    FROM pipeline_stage_runs WHERE stage='finlab_progress' AND business_date IN (${dates.map(() => '?').join(',')})`)
    .bind(...dates).all<{business_date:string;cursor_key:string|null}>()
    .then(r => new Map((r.results ?? []).map(row => [row.business_date,row])))
    .catch(() => new Map<string,{cursor_key:string|null}>())
  const batchProgressPromise = opsDb.prepare(`SELECT business_date,canonical_run_id,cursor_key
    FROM pipeline_stage_runs WHERE stage IN ('pipeline_batches:input_prep','pipeline_batches:prepare_prediction_request')
      AND business_date IN (${dates.map(() => '?').join(',')})`)
    .bind(...dates).all<{business_date:string;canonical_run_id:string;cursor_key:string|null}>()
    .then(r=>r.results??[]).catch(()=>[])
  const progressPromise = opsDb.prepare(`SELECT business_date,canonical_run_id,cursor_key
    FROM pipeline_stage_runs WHERE stage='pipeline_progress' AND business_date IN (${dates.map(() => '?').join(',')})`)
    .bind(...dates).all<{business_date:string;canonical_run_id:string;cursor_key:string|null}>()
    .then(r => new Map((r.results ?? []).map(row => [row.business_date,row])))
    .catch(() => new Map<string,{canonical_run_id:string;cursor_key:string|null}>())
  const durableStageStatesPromise = loadDurablePipelineStageStates(opsDb, dates).catch((error) => {
    console.warn('[schedulerStatus] durable pipeline stage read failed:', error)
    return new Map<string, DurablePipelineStageDisplayRow>()
  })
  await Promise.all(
    dates.map(async (date, index) => {
      const [aggregateLogs, directRootLog, directTodayCloseLog, directPremarketLog] = await Promise.all([
        getCronLogs(env.KV, date, {
          legacyFallback: index < SCHEDULER_STATUS_LEGACY_FALLBACK_DAYS,
          directFallback: false,
        }),
        env.KV.get(`scheduler:run:evening-chain:${date}`, 'json') as Promise<CronLogEntry | null>,
        index === 0
          ? env.KV.get(`scheduler:run:market-close-refresh:${date}`, 'json') as Promise<CronLogEntry | null>
          : Promise.resolve(null),
        index === 0
          ? env.KV.get(`scheduler:run:pre-market-warmup:${date}`, 'json') as Promise<CronLogEntry | null>
          : Promise.resolve(null),
      ])
      allLogs[date] = mergeDirectSchedulerLog(
        mergeDirectSchedulerLog(
          mergeDirectSchedulerLog(aggregateLogs, directRootLog), directTodayCloseLog,
        ), directPremarketLog,
      )
    }),
  )
  const cadenceDirectReads = JOB_DEFS.flatMap((def) => (
    def.group === 'weekly' || def.group === 'monthly'
      ? dates
        .filter((date) => isCurrentCadenceCycle(date, today, def.group) && (def.group === 'weekly' || Number(date.slice(8, 10)) <= 7 || date === today))
        .map((date) => ({ def, date }))
      : []
  ))
  const cadenceDirectLogs = await Promise.all(cadenceDirectReads.map(async ({ def, date }) => ({
    date,
    log: await env.KV.get(`scheduler:run:${def.id}:${date}`, 'json') as CronLogEntry | null,
  })))
  for (const { date, log } of cadenceDirectLogs) {
    allLogs[date] = mergeDirectSchedulerLog(allLogs[date] ?? [], log)
  }

  const [durableStageStates, schedulerExecutionTickets, premarketProgress, producerStates] = await Promise.all([
    durableStageStatesPromise,
    loadSchedulerExecutionTickets(opsDb, dates).catch((error) => {
      console.warn('[schedulerStatus] scheduler execution ticket read failed:', error)
      return [] as SchedulerExecutionTicketRow[]
    }),
    premarketProgressPromise,
    loadPremarketProducerStates(opsDb, today).catch((error) => {
      console.warn('[schedulerStatus] premarket producer read failed:', error)
      return []
    }),
  ])
  const executionTicketsByJobDate = new Map<string, SchedulerExecutionTicketRow>()
  const executionTicketsByTaskDate = new Map<string, SchedulerExecutionTicketRow>()
  const latestExecutionTicketByTask = new Map<string, SchedulerExecutionTicketRow>()
  for (const ticket of schedulerExecutionTickets) {
    const taskKey = `${ticket.business_date}:${ticket.task}`
    if (!executionTicketsByTaskDate.has(taskKey)) executionTicketsByTaskDate.set(taskKey, ticket)
    if (!latestExecutionTicketByTask.has(ticket.task)) latestExecutionTicketByTask.set(ticket.task, ticket)
    if (ticket.scheduler_job_id) {
      const jobKey = `${ticket.business_date}:${ticket.scheduler_job_id}`
      if (!executionTicketsByJobDate.has(jobKey)) executionTicketsByJobDate.set(jobKey, ticket)
    }
  }
  const { activeChainDate, chainStatusDate } = selectSchedulerChainDates(dates, allLogs)
  const chainDisplayDate = selectSchedulerChainDisplayDate({
    today,
    activeChainDate,
    chainStatusDate,
    logsByDate: allLogs,
  })
  if (chainDisplayDate) {
    const activeTaskIds = CHAIN_STEP_IDS.filter((task) => task !== 'evening-chain')
    const directChainLogs = await Promise.all(activeTaskIds.map((task) => (
      env.KV.get(`scheduler:run:${task}:${chainDisplayDate}`, 'json') as Promise<CronLogEntry | null>
    )))
    allLogs[chainDisplayDate] = directChainLogs.reduce(
      (logs, directLog) => mergeDirectSchedulerLog(logs, directLog),
      allLogs[chainDisplayDate] ?? [],
    )
  }
  // An event-driven job (no readable cron) is due at the Taiwan time of day of its latest receipt on another day.
  const usualRunMsOnTwDate = (def: JobDef, date: string): number => {
    const previous = dates.filter((other) => other < date).map((other) => getJobDisplayLog(allLogs[other], def)?.timestamp)
      .map((timestamp) => parseLogTime(timestamp)).find((ms): ms is number => ms != null)
    if (previous == null) return Number.POSITIVE_INFINITY
    return Date.parse(`${date}T00:00:00.000Z`) - 8 * 3600_000 + (((previous + 8 * 3600_000) % 86400_000) + 86400_000) % 86400_000
  }
  // Gap fill: skip jobs read directly above (root, today's close and warmup, chain display, cadence) and
  // watchdogs (window-gated below). A missing row is read only for a job logged on another scanned day,
  // so jobs that do not run daily cost nothing, and today only once the job is due (its cron fired today,
  // or for an event-driven job its usual time passed); jobs that have not run yet would take every slot. Non-terminal rows first, then yesterday, then today.
  const directGapReads = dates.slice(0, SCHEDULER_STATUS_DIRECT_READ_DAYS).flatMap((date, dayIndex) => JOB_DEFS
    .filter((def) => !def.id.endsWith('-watchdog') && def.group !== 'weekly' && def.group !== 'monthly'
      && def.id !== 'evening-chain'
      && !(dayIndex === 0 && (def.id === 'market-close-refresh' || def.id === 'pre-market-warmup'))
      && !(date === chainDisplayDate && CHAIN_STEP_IDS.includes(def.id)))
    .flatMap((def) => {
      const log = getJobDisplayLog(allLogs[date], def)
      if (log ? !SCHEDULER_STATUS_NON_TERMINAL.has(log.status)
        : !dates.some((other) => other !== date && getJobDisplayLog(allLogs[other], def))) return []
      if (!log && dayIndex === 0 && !((firstScheduledRunMsOnTwDate(def, date) ?? usualRunMsOnTwDate(def, date)) <= nowMs)) return []
      return [{ def, date, rank: log ? 0 : 2 - dayIndex }]
    }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SCHEDULER_STATUS_DIRECT_READ_LIMIT)
  // Display only, merged after the gate snapshot: an unreadable key keeps the aggregate's reading.
  const directGapLogsPromise = Promise.all(directGapReads.map(async (read) => ({
    ...read,
    log: await (env.KV.get(`scheduler:run:${read.def.id}:${read.date}`, 'json') as Promise<CronLogEntry | null>).catch(() => null),
  })))
  // Q41: the deploy gate keeps main's failed24h. Snapshot the logs it reads (no canonical watchdog keys,
  // no FinLab watchdog receipts, no dispatch wait_until) before the display-only enrichment below.
  const gateLogs: Record<string, CronLogEntry[]> = Object.fromEntries(Object.entries(allLogs)
    .map(([date, logs]) => [date, logs
      .filter((entry) => !GATE_UNREAD_TASKS.has(entry.task))
      .map((entry) => (entry.wait_until === undefined ? entry : { ...entry, wait_until: undefined }))]))
  // Jobs whose display log the gap fill changed; their gate view is replayed on gateLogs below.
  const gapFilledJobIds = new Set<string>()
  for (const { def, date, log } of await directGapLogsPromise) {
    const before = getJobDisplayLog(allLogs[date], def)
    allLogs[date] = mergeDirectSchedulerLog(allLogs[date] ?? [], log)
    if (getJobDisplayLog(allLogs[date], def) !== before) gapFilledJobIds.add(def.id)
  }
  // Watchdog ticks fire together and the daily aggregate is a best-effort read-modify-write, so before a
  // watchdog can be judged missed its canonical per-task key decides whether it ran inside today's window.
  const directWatchdogLogs = await Promise.all(JOB_DEFS
    .filter((def) => {
      const openMs = watchdogWindowOpenMs(def, today)
      return openMs != null && nowMs >= openMs + WATCHDOG_FIRST_RECEIPT_GRACE_MS
        && (parseLogTime(getJobDisplayLog(allLogs[today], def)?.timestamp) ?? Number.NEGATIVE_INFINITY) < openMs
    })
    // Display only: an unreadable or malformed key leaves the aggregate's reading, never fails the page or the gate.
    .map((def) => (env.KV.get(`scheduler:run:${def.id}:${today}`, 'json') as Promise<CronLogEntry | null>).catch(() => null)))
  allLogs[today] = directWatchdogLogs.reduce((logs, directLog) => mergeDirectSchedulerLog(logs, directLog), allLogs[today] ?? [])
  const activeReplayHeartbeatAt = activeChainDate
    ? (allLogs[activeChainDate] ?? [])
      .filter((entry) => (
        CHAIN_STEP_IDS.includes(entry.task)
        && String(entry.run_date ?? activeChainDate) === activeChainDate
      ))
      .reduce<string | undefined>((latest, entry) => {
        const timestampMs = parseLogTime(entry.timestamp)
        if (timestampMs == null) return latest
        const latestMs = parseLogTime(latest)
        return latestMs == null || timestampMs > latestMs ? String(entry.timestamp) : latest
      }, undefined)
    : undefined
  const replayClosureAt = chainStatusDate
    ? (allLogs[chainStatusDate] ?? []).find((entry) => entry.task === 'evening-chain' && entry.status === 'success')?.timestamp
    : undefined

  // One read, only once a watchdog window has opened on a weekday.
  // A failed read counts as a trading day, so a missed watchdog stays visible.
  let todayHoliday: Promise<boolean> | undefined
  const isTodayHoliday = () => todayHoliday ??= (async () => Boolean(await env.KV.get(`holiday:${today}`)))().catch(() => false)

  const gateViewByJob = new Map<string, {
    lastStatus: string; todayLog?: CronLogEntry; cells: ReturnType<typeof resolveSchedulerHistoryCell>[]
  }>()
  // `allLogs` is a parameter so a gap-filled job can be replayed on gateLogs for its gate view.
  const deriveJob = async (def: JobDef, allLogs: Record<string, CronLogEntry[]>) => {
    const todayLog = getJobDisplayLog(allLogs[today], def)
    const chainReplayLog = chainDisplayDate && CHAIN_STEP_IDS.includes(def.id)
      ? getJobDisplayLog(allLogs[chainDisplayDate], def)
      : undefined
    const nextRun = await getNextRunApproxWithPolicy({ task: def.id, cron: def.cron, kv: env.KV, skipKvPolicy: true })
    const accounting = schedulerJobAccounting(def.id, def.chainIndex)

    const displayLogs = dates.map((date) => ({
      date,
      log: getJobDisplayLog(allLogs[date], def),
    }))
    const { lastAttempt, lastEffective } = selectSchedulerDisplayLogs(displayLogs)
    const lastLog = lastAttempt ?? lastEffective
    const cadenceCycleLog = displayLogs.find(({ date, log }) => (
      Boolean(log) && isCurrentCadenceCycle(date, today, def.group)
    ))?.log


    const historyCells = displayDates.map((date) => resolveSchedulerHistoryCell({
      def,
      date,
      log: getJobDisplayLog(allLogs[date], def),
      rootLog: allLogs[date]?.find((entry) => entry.task === 'evening-chain'),
      durable: durableStageStates.get(`${date}:${def.id}`),
      nowMs,
    }))
    const history7d = historyCells.map(({ cell }) => cell).reverse()
    const gateCells = displayDates.map((date) => resolveSchedulerHistoryCell({
      def,
      date,
      log: getJobDisplayLog(gateLogs[date], def),
      rootLog: gateLogs[date]?.find((entry) => entry.task === 'evening-chain'),
      durable: durableStageStates.get(`${date}:${def.id}`),
      nowMs,
    }))

    const baseResolvedDisplay = resolveSchedulerDisplayStatus({
      todayLog,
      lastAttempt,
      activeReplayLog: chainReplayLog,
      activeReplayRunDate: chainDisplayDate,
      activeReplayHeartbeatAt,
      activeReplayClosureAt: replayClosureAt,
      activeReplayIsRunning: Boolean(activeChainDate && chainDisplayDate === activeChainDate),
      def,
      cadenceCycleLog,
      nextRun,
      today,
      holiday: nowMs >= (watchdogWindowOpenMs(def, today) ?? Number.POSITIVE_INFINITY) ? await isTodayHoliday() : false,
      nowMs,
    })
    const chainScopedDisplay = resolveBusinessDateScopedChainDisplay({
      def,
      chainStatusDate: chainDisplayDate,
      today,
      exactLog: chainReplayLog,
      heartbeatAt: chainDisplayDate === activeChainDate ? activeReplayHeartbeatAt : undefined,
      nowMs,
    })
    let resolvedDisplay = chainScopedDisplay?.resolvedDisplay ?? baseResolvedDisplay
    let displayLog = chainScopedDisplay ? chainScopedDisplay.displayLog : lastLog
    const durableEventDisplay = resolveDurableEventDisplay({
      jobId: def.id,
      today,
      baseTimestamp: displayLog?.timestamp,
      ticket: latestExecutionTicketByTask.get(def.id),
    })
    if (durableEventDisplay) {
      resolvedDisplay = durableEventDisplay
      displayLog = undefined
    }
    const durableState = resolvedDisplay.statusRunDate
      ? durableStageStates.get(`${resolvedDisplay.statusRunDate}:${def.id}`)
      : undefined
    const durableOverride = reconcileDurablePipelineStageStatus({
      jobId: def.id,
      runDate: resolvedDisplay.statusRunDate,
      baseStatus: resolvedDisplay.status,
      baseTimestamp: displayLog?.timestamp,
      baseDispatchRunId: triggeredDispatchRunId(displayLog),
      durable: durableState,
    })
    const handoffStage = displayLog?.status === 'triggered' && /cloud_compute_stopped=true/.test(displayLog.summary ?? '')
      ? /(?:^|\s)stage=([a-z_]+)(?:\s|$)/.exec(displayLog.summary ?? '')?.[1] : undefined
    const pipelineProgress = def.id === 'pipeline' ? pipelineProgressForDisplay(durableState,
      (await progressPromise).get(resolvedDisplay.statusRunDate ?? ''),
      handoffStage && displayLog?.run_id ? { runId: displayLog.run_id, observedAt: displayLog.timestamp,
        phase: handoffStage === 'modal_prediction' ? handoffStage : `input_${handoffStage}` } : undefined) : null
    const progressActive = pipelineProgress && durableState && ['running','waiting'].includes(durableState.status)
      && !['success','failed'].includes(resolvedDisplay.status)
      const pipelineWork = progressActive && pipelineProgress.status === 'waiting'
        ? await loadPipelineInputWork(env, durableState.canonical_run_id, resolvedDisplay.statusRunDate!, pipelineProgress.phase)
        : undefined
    const progressStatus = progressActive ? (pipelineProgress.status === 'waiting' ? 'waiting' as const : 'running' as const) : null
    const baseLastStatus = progressStatus ?? durableOverride?.lastStatus ?? resolvedDisplay.status
    const baseTimestamp = durableOverride?.lastRunAt ?? displayLog?.timestamp ?? null
    const executionTicketDate = resolvedDisplay.statusRunDate ?? today
    const executionTicket = selectSchedulerExecutionTicketForDisplay({
      exactTaskTicket: executionTicketsByTaskDate.get(`${executionTicketDate}:${accounting.task}`),
      exactJobTicket: accounting.schedulerJobId
        ? executionTicketsByJobDate.get(`${executionTicketDate}:${accounting.schedulerJobId}`)
        : undefined,
      latestTaskTicket: latestExecutionTicketByTask.get(accounting.task),
      physicalRoot: accounting.physicalRoot,
      scopedRunDate: resolvedDisplay.statusRunDate,
    })
    const executionTicketOverride = reconcileSchedulerExecutionTicketStatus({
      baseStatus: baseLastStatus,
      // A ticket left by last night's after-midnight tick cannot stand in for tonight's missed window.
      baseTimestamp: resolvedDisplay.windowOpenedAt ?? baseTimestamp,
      ticket: executionTicket,
      expectedRunDate: resolvedDisplay.statusRunDate,
    })
    const readinessDisplay = premarketReadinessDisplay(def.id, today, premarketProgress, executionTicket?.updated_at)
    const activePremarket = premarketExecutionDisplay({
      jobId: def.id, today, businessDate: resolvedDisplay.statusRunDate, rows: premarketProgress,
      pipeline: durableStageStates.get(`${resolvedDisplay.statusRunDate}:pipeline`),
      ticketStatus: executionTicket?.status,
    })
    const phaseDisplay = readinessDisplay
      ? { ...readinessDisplay, lastRun: formatTimestamp(readinessDisplay.lastRunAt) }
      : (activePremarket
      ? { ...activePremarket, lastRun: formatTimestamp(activePremarket.lastRunAt) }
      : sealedPremarketDisplay({
      jobId: def.id, businessDate: resolvedDisplay.statusRunDate,
      stage: durableStageStates.get(`${resolvedDisplay.statusRunDate}:pipeline`),
      log: allLogs[resolvedDisplay.statusRunDate ?? '']?.find(row => row.task === 'pipeline'),
      ticketStatus: executionTicket?.status,
    }))
    // A watchdog owing tonight's receipt is judged on this window only, never on an older receipt's note.
    const watchdogDisplay = resolvedDisplay.windowOpenedAt ? null : premarketWatchdogDisplay(def.id, displayLog, executionTicket?.status)
    // Only watchdog rows are enriched (window gap, canonical keys, FinLab watchdog receipts): for them the gate
    // replays the PR-base reading on gateLogs. No durable, phase or producer display applies to a watchdog.
    const watchdogGateView = def.id.endsWith('-watchdog') ? (() => {
      const gateTodayLog = getJobDisplayLog(gateLogs[today], def)
      const base = selectSchedulerDisplayLogs(dates.map((date) => ({ date, log: getJobDisplayLog(gateLogs[date], def) })))
      const baseLog = base.lastAttempt ?? base.lastEffective
      const resolved = resolveSchedulerDisplayStatus({
        todayLog: gateTodayLog, lastAttempt: base.lastAttempt, def, nextRun, today, nowMs, windowGap: false,
      })
      const ticketDate = resolved.statusRunDate ?? today
      const ticket = selectSchedulerExecutionTicketForDisplay({
        exactTaskTicket: executionTicketsByTaskDate.get(`${ticketDate}:${accounting.task}`),
        exactJobTicket: accounting.schedulerJobId ? executionTicketsByJobDate.get(`${ticketDate}:${accounting.schedulerJobId}`) : undefined,
        latestTaskTicket: latestExecutionTicketByTask.get(accounting.task),
        physicalRoot: accounting.physicalRoot,
        scopedRunDate: resolved.statusRunDate,
      })
      const ticketStatus = reconcileSchedulerExecutionTicketStatus({
        baseStatus: resolved.status, baseTimestamp: baseLog?.timestamp ?? null, ticket, expectedRunDate: resolved.statusRunDate,
      })?.lastStatus
      return {
        lastStatus: premarketWatchdogDisplay(def.id, baseLog, ticket?.status)?.lastStatus ?? ticketStatus ?? resolved.status,
        todayLog: gateTodayLog,
        cells: gateCells,
      }
    })() : null
    const producerDisplay = premarketProducerDisplay(def.id, today, producerStates)
    const lastStatus = producerDisplay?.lastStatus ?? watchdogDisplay?.lastStatus ?? phaseDisplay?.lastStatus ?? executionTicketOverride?.lastStatus ?? baseLastStatus
    gateViewByJob.set(def.id, watchdogGateView ?? { lastStatus, todayLog: getJobDisplayLog(gateLogs[today], def), cells: gateCells })
    const displayTime = executionTicketOverride
      ? { timestamp: executionTicketOverride.lastRunAt, basis: 'updated' as const }
      : resolveSchedulerRunDisplayTime({
          jobId: def.id,
          displayTimestamp: baseTimestamp,
          durable: durableState,
        })

    const ticketRunId = executionTicketOverride?.runId ?? durableOverride?.runId ?? displayLog?.run_id ?? null
    const ticketId = executionTicketOverride?.ticketId ?? ticketRunId
    const ticketAuthority = executionTicketOverride?.statusAuthority ?? durableOverride?.statusAuthority ?? 'scheduler_kv'
    const ticketRunDate = executionTicket?.business_date ?? resolvedDisplay.statusRunDate
    const ticket = {
      ticketId,
      physicalRootId: accounting.schedulerJobId,
      logicalTask: accounting.task,
      status: lastStatus,
      runDate: ticketRunDate,
      authority: ticketAuthority,
      durable: ticketAuthority !== 'scheduler_kv',
      missing: accounting.ticketRequired && !ticketId,
    }
    // Recover legacy zero placeholders from exact-run metadata without rewriting
    // historical receipts. Missing/expired timing stays unknown, never '<1s'.
    let displayDuration = displayLog?.duration_ms
    if (lastStatus === 'blocked') displayDuration = null
    if (def.id === 'indicator-queue' && displayDuration === 0) {
      displayDuration = null
      const date = displayLog?.run_date ?? resolvedDisplay.statusRunDate
      if (displayLog?.status === 'success' && displayLog.run_id && date) {
        const meta = await env.KV.get(`cron:indicator-queue:${date}:${displayLog.run_id}:meta`, 'json')
        displayDuration = indicatorQueueDurationMs(meta, date, displayLog.run_id, Date.parse(displayLog.timestamp))
      }
    }
    const lastDuration = formatDuration(displayDuration)
    const shortRun = inferShortRunConcern(def, displayLog)

    if (producerDisplay) history7d[history7d.length - 1] = producerDisplay.lastStatus === 'error' ? 'failed'
      : producerDisplay.lastStatus === 'success' ? 'success' : producerDisplay.lastStatus === 'waiting' ? 'waiting' : 'running'
    // A missed watchdog window is today's missing run in the strip and the SLO; failed24h (the deploy gate) does not see it.
    // An in-window ticket that failed is a real failure with its own error, not a miss.
    const missedWindow = Boolean(resolvedDisplay.windowOpenedAt) && lastStatus === 'failed' && !executionTicketOverride
    if (missedWindow && history7d[history7d.length - 1] !== 'failed') history7d[history7d.length - 1] = 'missing'
    const successCount = history7d.filter((item) => item === 'success').length
    const totalCount = history7d.filter((item) => SLO_COUNTED_CELLS.has(item)).length

    return {
      id: def.id,
      name: def.name,
      schedule: def.schedule,
      cron: def.cron,
      group: def.group,
      chainIndex: def.chainIndex,
      lastRun: displayTime.timestamp ? formatTimestamp(displayTime.timestamp) : 'N/A',
      lastRunAt: displayTime.timestamp,
      lastRunBasis: displayTime.basis,
      lastAttempt: lastAttempt?.timestamp ? formatTimestamp(lastAttempt.timestamp) : 'N/A',
      lastAttemptAt: lastAttempt?.timestamp ?? null,
      lastAttemptStatus: lastAttempt?.status ?? 'none',
      lastEffectiveRun: lastEffective?.timestamp ? formatTimestamp(lastEffective.timestamp) : 'N/A',
      lastEffectiveRunAt: lastEffective?.timestamp ?? null,
      lastEffectiveStatus: lastEffective?.status ?? 'none',
      lastStatus,
      missedWindow,
      attentionReason: lastStatus === 'skip' ? schedulerSkipAttentionReason(displayLog) : null,
      statusScope: resolvedDisplay.statusScope,
      statusRunDate: resolvedDisplay.statusRunDate,
      lastDuration,
      durationConcern: shortRun.durationConcern,
      durationConcernReason: shortRun.durationConcernReason,
      lastError: executionTicketOverride
        ? executionTicketOverride.lastError
        : durableOverride
          ? durableOverride.lastError
          : resolvedDisplay.staleReason ?? displayLog?.error,
      nextRun,
      history7d,
      rate7d: totalCount > 0 ? `${successCount}/${totalCount}` : 'N/A',
      pipelineProgress: pipelineProgress ? { ...pipelineProgress, run_id: durableState?.canonical_run_id, run_date: resolvedDisplay.statusRunDate } : null,
      pipelineWork,
      pipelineBatches: def.id === 'pipeline' ? (await batchProgressPromise)
        .filter(row=>row.business_date===resolvedDisplay.statusRunDate && row.canonical_run_id===durableState?.canonical_run_id)
        .flatMap(row=>{try { return [JSON.parse(row.cursor_key??'')] } catch { return [] }}) : undefined,
      finlabProgress: def.id === 'finlab-v4-backfill' ? finlabProgressForDisplay(displayLog,
        (await finlabProgressPromise).get(resolvedDisplay.statusRunDate ?? '')) : null,
      summary: progressActive ? `phase=${pipelineProgress.phase} phase_status=${pipelineProgress.status} execution=${pipelineProgress.execution_id}`
        : executionTicketOverride?.summary ?? durableOverride?.summary ?? displayLog?.summary ?? '',
      details: displayLog?.details ?? [],
      runId: ticketRunId,
      attemptId: executionTicketOverride?.attemptId ?? displayLog?.attempt_id ?? null,
      attemptCount: executionTicketOverride?.attemptCount ?? durableOverride?.attemptCount ?? null,
      recoveredFromStatus: durableOverride?.recoveredFromStatus ?? null,
      statusAuthority: ticketAuthority,
      consolidation: getSchedulerDependencySpec(accounting.task) ?? null,
      accounting,
      ticket: { ...ticket, ...(phaseDisplay ? { status: phaseDisplay.lastStatus, authority: phaseDisplay.statusAuthority, durable: true } : {}),
        ...(readinessDisplay ? { ticketId: readinessDisplay.runId, runDate: today, missing: false } : {}),
        ...(producerDisplay ? {ticketId: producerDisplay.runId, status: producerDisplay.lastStatus, runDate: today,
          authority: producerDisplay.statusAuthority, durable: true, missing: false} : {}) },
      ...phaseDisplay,
      ...watchdogDisplay,
      ...(producerDisplay ? {...producerDisplay, lastRun: formatTimestamp(producerDisplay.lastRunAt), lastRunBasis: 'updated' as const,
        recoveredFromStatus: producerDisplay.lastStatus !== baseLastStatus ? baseLastStatus : null} : {}),
      // FU8-A: after the spreads so no display override can replace them. Stage cards match progress by these ids,
      // never by the ticket runId, which differs from the canonical run whenever a ticket owns the display.
      canonicalRunId: durableState?.canonical_run_id ?? null,
      finlabRunId: def.id === 'finlab-v4-backfill' ? displayLog?.run_id ?? null : null,
    }
  }
  const jobs = await Promise.all(JOB_DEFS.map((def) => deriveJob(def, allLogs)))
  // Q41: the gate never sees the gap fill. Replaying a gap-filled job on gateLogs resets its gate view
  // (status, today's log, cells) to main's aggregate reading; the returned display row is discarded.
  await Promise.all(JOB_DEFS.filter((def) => gapFilledJobIds.has(def.id)).map((def) => deriveJob(def, gateLogs)))

  const failed24hJobIds = new Set(jobs.filter((job) => {
    const gate = gateViewByJob.get(job.id)
    if ((gate?.lastStatus ?? job.lastStatus) === 'blocked') return false
    const todayLog = gate?.todayLog
    if (job.statusAuthority === 'durable_pipeline_stage' && ['news-analyst','us-leading'].includes(job.id)
      && job.statusRunDate === today) return job.lastStatus === 'error'
    if (todayLog?.status === 'error') return true
    // By run_date: a replay-date failure seen in the last 24h, or a run still stuck past its SLA
    // that no later successful run of the job has replaced (cells run newest first).
    const cells = gate?.cells ?? []
    return cells.some(({ cell, evidenceAt, stuck }, index) => cell === 'failed' && (stuck
      ? !cells.slice(0, index).some((later) => later.cell === 'success')
      : nowMs - (parseLogTime(evidenceAt ?? undefined) ?? Number.NEGATIVE_INFINITY) <= 24 * 3600_000))
  }).map((job) => job.id))
  const failed24h = failed24hJobIds.size

  const allRuns = jobs.flatMap((job) => job.history7d.filter((item) => SLO_COUNTED_CELLS.has(item)))
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
      // Display only: watchdogs that missed today's window and are not already in failed24h, which the deploy gate reads.
      missed24h: jobs.filter((job) => job.missedWindow && !failed24hJobIds.has(job.id)).length,
      successRate7d: successRate,
      nextJob: nextJob?.name || 'N/A',
      nextIn: nextJob?.nextRun || 'N/A',
    },
    jobs,
    governance: {
      ...schedulerGovernanceSummary(jobs.filter((job) => !job.accounting.physicalRoot).length),
      ticketContractRoots: SCHEDULER_TICKET_CONTRACT_ROOTS,
      observedTicketRoots: new Set(
        schedulerExecutionTickets.map((ticket) => ticket.scheduler_job_id).filter(Boolean),
      ).size,
      terminalTicketRoots: new Set(
        schedulerExecutionTickets
          .filter((ticket) => ['success', 'error', 'skipped', 'blocked'].includes(ticket.status))
          .map((ticket) => ticket.scheduler_job_id)
          .filter(Boolean),
      ).size,
      runtimeTicketedJobs: jobs.filter((job) => Boolean(job.ticket.ticketId)).length,
      runtimeTicketMissingJobs: jobs.filter((job) => job.ticket.missing).length,
      durableTicketedJobs: jobs.filter((job) => job.ticket.durable).length,
    },
    dag: {
      lastRun: allLogs[today]?.find((entry) => entry.task === 'pipeline')?.timestamp || 'N/A',
      totalDuration: allLogs[today]?.find((entry) => entry.task === 'pipeline')?.duration_ms || 0,
      steps: dagSteps,
    },
    heatmap,
    dates: displayDates.reverse(),
  }
}
