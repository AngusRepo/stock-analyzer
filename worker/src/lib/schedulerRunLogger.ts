/**
 * schedulerRunLogger.ts - Scheduler run result persistence and alerting
 */

export type SchedulerRunStatus = 'success' | 'error' | 'skipped' | 'triggered' | 'running'

export interface SchedulerRunLogEntry {
  task: string
  status: SchedulerRunStatus
  summary: string
  details?: string[]
  duration_ms: number
  timestamp: string
  run_id?: string
  attempt_id?: string
  run_date?: string
  run_scope?: 'live_canonical' | 'historical_replay' | 'derived'
  error?: string
}

export interface SchedulerRunLogReadOptions {
  legacyFallback?: boolean
  directFallback?: boolean
}

type SchedulerRunResultInput = Omit<SchedulerRunLogEntry, 'task' | 'timestamp'> & {
  date?: string
  run_date?: string
  strict?: boolean
}

const TASK_NAMES: Record<string, string> = {
  'pre-market-warmup': 'Pre-market Warmup',
  'market-close-refresh': 'Market Close Refresh',
  'evening-chain': 'Evening Chain',
  update: 'Market Data Update',
  'indicator-queue': 'Indicator Queue',
  'ml-warmup': 'ML Warmup',
  'post-pipeline-chain': 'Post Pipeline Chain',
  'post-verify-chain': 'Post Verify Chain',
  'post-screener-pipeline': 'Post Screener Pipeline Continuation',
  'dataset-snapshot-export': 'Dataset Snapshot Export',
  'linucb-reward-ledger': 'LinUCB Reward Ledger',
  'adaptive-meta-policy-replay': 'Adaptive Meta Policy Replay',
  'linucb-multiplier-replay': 'LinUCB Multiplier Replay',
  'meta-learning-shadow': 'Meta Learning Shadow',
  'strategy-learning': 'Strategy Learning',
  's12-replay-backfill': 'S12 Replay Backfill',
  pipeline: 'Pipeline',
  'ml-predict': 'ML Predict',
  recommendation: 'Daily Recommendation',
  screener: 'Screener',
  'screener-v2': 'Screener V2 Job Trigger',
  'us-leading': 'US Leading',
  'news-analyst': 'News Analyst',
  'morning-setup': 'Morning Setup',
  'morning-briefing': 'Morning Briefing',
  'daily-snapshot': 'Daily Snapshot',
  adapt: 'Adapt Params',
  'daily-report': 'Daily Report',
  'paper-intraday-cache-clear': 'Paper Intraday Cache Clear',
  'paper-active-postmarket': 'Paper Active Postmarket',
  'obsidian-daily': 'Obsidian Notes',
  'obsidian-sync': 'Obsidian Sync',
  'regime-compute': 'HMM Regime',
  'verify-v2': 'Verify (V2 LangGraph)',
  'debate-memory-retention': 'Debate Memory Retention',
  'audit-json-retention': 'Audit JSON Retention',
  'artifact-reconcile': 'Artifact Reconcile',
  'legacy-evidence-migration': 'Legacy Evidence Migration',
  'legacy-strategy-evidence-migration': 'Legacy Strategy Evidence Migration',
  'legacy-hot-data-retirement': 'Legacy Hot Data Retirement',
  'd1-evidence-scrub': 'D1 Evidence Scrub',
  'r2-retention-sweep': 'R2 Retention Sweep',
  'orphan-reachability-gc': 'Orphan Reachability GC',
  'cleanup-dlq-replay': 'Cleanup DLQ Replay',
  'storage-health-check': 'Storage Health Check',
  'storage-health-gate': 'Storage Health Check (Legacy Alias)',
  'storage-integrity-audit': 'Storage Integrity Audit',
  'storage-capacity-report': 'Storage Capacity Report',
  'strategy-learning-finalize': 'Strategy Learning Finalizer',
  'data-domain-shadow-backfill': 'Data Domain Shadow Backfill',
  'intraday-check': 'Limit Buy + SL/TP',
  'intraday-rescore': 'Intraday Re-score',
  'rescore-10': 'Intraday Re-score 10:00',
  'rescore-11': 'Intraday Re-score 11:00',
  'rescore-12': 'Intraday Re-score 12:00',
  'rescore-1230': 'Intraday Re-score 12:30',
  'eod-exit': 'EOD Exit',
  'post-close-price-refresh': 'Post-close Price Refresh',
  'weekly-audit': 'Weekly Audit',
  'model-ic-rolling': 'Model IC Rolling',
  'model-ic-full-check': 'Model IC Full Check',
  'finlab-v4-backfill': 'FinLab V4 Backfill',
  'allocator-ev-lifecycle-watchdog': 'Allocator EV Lifecycle Watchdog',
  'active8-oof-daily': 'Active-8 OOF Daily Materialize',
  'active8-oof-weekly': 'Active-8 OOF Weekly Cohort',
  'active8-oof-monthly': 'Active-8 OOF Monthly Cohort',
  'weekly-cleanup': 'Weekly Cleanup',
  'weekly-backtest': 'Weekly Backtest/MC',
  'alpha-quality': 'Alpha Quality',
  'weekly-optuna': 'Weekly Optuna',
  'allocator-ev-feature-snapshot-backfill': 'Allocator EV Feature Snapshot Backfill',
  'allocator-ev-readiness': 'Allocator EV Readiness',
  'opb-arm-prior-refresh': 'OPB Arm Prior Refresh',
  'l4-alpha-ev-refresh': 'L4 Alpha EV Refresh',
  'allocator-ev-fusion-refresh': 'Allocator EV Fusion Refresh',
  'monthly-opb-arm-prior-refresh': 'Monthly OPB Arm Prior Refresh',
  'sector-leaders': 'Sector Leaders',
  'monthly-optuna': 'Monthly Optuna',
  'monthly-l4-alpha-ev-refresh': 'Monthly L4 Alpha EV Refresh',
  'monthly-allocator-ev-fusion-refresh': 'Monthly Allocator EV Fusion Refresh',
  'monthly-strategy-mining': 'Monthly Strategy Mining',
  'optuna-queue': 'Optuna Queue Processor',
  'monthly-retrain': 'Monthly Universal Retrain',
  verify: 'Verify (compat alias)',
}

const DAILY_RUN_LOG_TTL_SECONDS = 7 * 86400

export function getSchedulerLogTaskCount(): number {
  return Object.keys(TASK_NAMES).length
}

export function getTaskDisplayName(task: string): string {
  return TASK_NAMES[task] ?? task
}

export function isSchedulerRunStatus(status: unknown): status is SchedulerRunStatus {
  return (
    status === 'success' ||
    status === 'error' ||
    status === 'skipped' ||
    status === 'triggered' ||
    status === 'running'
  )
}

export function classifySchedulerRunSummary(summary: string): SchedulerRunStatus {
  const normalized = summary.trim().toLowerCase()
  if (
    normalized.startsWith('running') ||
    normalized.includes('started (background)') ||
    normalized.includes('background running')
  ) {
    return 'running'
  }
  if (
    normalized.startsWith('triggered') ||
    normalized.includes('callback expected') ||
    normalized.includes('awaiting callback')
  ) {
    return 'triggered'
  }
  if (
    normalized.startsWith('skip') ||
    normalized.startsWith('skipped') ||
    normalized.startsWith('locked') ||
    normalized === 'empty' ||
    normalized.startsWith('no ')
  ) {
    return 'skipped'
  }
  if (
    normalized.startsWith('failed') ||
    normalized.startsWith('error') ||
    normalized.includes('failed_validation') ||
    normalized.includes('promotion_failed')
  ) {
    return 'error'
  }
  if (
    normalized.includes('kv=fail') ||
    normalized.includes('kv push failed') ||
    normalized.includes('did not update kv')
  ) {
    return 'error'
  }
  return 'success'
}

export function resolveMonotonicSchedulerEntry(
  previous: SchedulerRunLogEntry | null,
  incoming: SchedulerRunLogEntry,
): SchedulerRunLogEntry {
  if (!previous || previous.run_date !== incoming.run_date) return incoming
  const explicitNewRun = Boolean(incoming.run_id) && previous.run_id !== incoming.run_id
  const explicitNewAttempt = Boolean(incoming.attempt_id) && previous.attempt_id !== incoming.attempt_id
  if (explicitNewRun || explicitNewAttempt) return incoming
  if (previous.status === 'error' && incoming.status !== 'error') return previous
  if (previous.status === 'success' && ['running', 'triggered', 'skipped'].includes(incoming.status)) return previous
  return incoming
}

export async function logSchedulerRunResult(
  kv: KVNamespace,
  task: string,
  result: SchedulerRunResultInput,
  env?: { DISCORD_WEBHOOK_URL?: string },
): Promise<void> {
  const requestedDate = String(result.run_date ?? result.date ?? '').trim()
  const today = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const incoming: SchedulerRunLogEntry = {
    task,
    status: result.status,
    summary: result.summary,
    details: result.details,
    duration_ms: result.duration_ms,
    run_id: result.run_id,
    attempt_id: result.attempt_id,
    run_date: today,
    run_scope: result.run_scope,
    error: result.error,
    timestamp: new Date().toISOString(),
  }

  try {
    const previous = await kv.get(`scheduler:run:${task}:${today}`, 'json') as SchedulerRunLogEntry | null
    const entry = resolveMonotonicSchedulerEntry(previous, incoming)
    const payload = JSON.stringify(entry)
    await Promise.all([
      kv.put(`scheduler:run:${task}:${today}`, payload, { expirationTtl: DAILY_RUN_LOG_TTL_SECONDS }),
      kv.put(`cron:log:${task}:${today}`, payload, { expirationTtl: DAILY_RUN_LOG_TTL_SECONDS }),
    ])

    const aggregateKey = `scheduler:run:daily:${today}`
    const aggregate = await kv.get(aggregateKey, 'json') as Record<string, SchedulerRunLogEntry> | null
    await kv.put(
      aggregateKey,
      JSON.stringify({ ...(aggregate ?? {}), [task]: entry }),
      { expirationTtl: DAILY_RUN_LOG_TTL_SECONDS },
    )
  } catch (error) {
    // Scheduler run logging should never break the task itself, but silent failure
    // makes Scheduler incidents impossible to diagnose.
    console.warn(`[schedulerRunLogger] KV write failed for task=${task}:`, error)
    if (result.strict) throw error
  }

  if (result.status === 'error' && env?.DISCORD_WEBHOOK_URL) {
    const critical = new Set(['pipeline', 'ml-predict', 'ml', 'recommendation', 'morning-setup', 'paper-trade', 'verify-v2'])
    const dedupKey = `cron:alert:${task}:${today}`

    try {
      const already = await kv.get(dedupKey)
      if (!already || critical.has(task)) {
        const displayName = getTaskDisplayName(task)
        const message = [
          `Scheduler Fail: ${displayName} (\`${task}\`)`,
          `Date: ${today}`,
          `Duration: ${(result.duration_ms / 1000).toFixed(1)}s`,
          `Summary: ${(result.summary || '').slice(0, 500)}`,
          result.error ? `Error: \`${String(result.error).slice(0, 300)}\`` : null,
        ].filter(Boolean).join('\n')

        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})

        await kv.put(dedupKey, '1', { expirationTtl: 86400 }).catch(() => {})
      }
    } catch {
      // Alerting must never block cron execution.
    }
  }
}

export async function getSchedulerRunLogs(
  kv: KVNamespace,
  date: string,
  options: SchedulerRunLogReadOptions = {},
): Promise<SchedulerRunLogEntry[]> {
  const tasks = Object.keys(TASK_NAMES)
  const results: SchedulerRunLogEntry[] = []
  const legacyFallback = options.legacyFallback !== false
  const directFallback = options.directFallback !== false

  const aggregate = await kv.get(`scheduler:run:daily:${date}`, 'json') as Record<string, SchedulerRunLogEntry> | SchedulerRunLogEntry[] | null
  if (aggregate) {
    const values = Array.isArray(aggregate) ? aggregate : Object.values(aggregate)
    for (const entry of values) {
      if (entry?.task && tasks.includes(entry.task)) results.push(entry)
    }
  }

  if (aggregate || !directFallback) {
    return fillMissingSchedulerLogs(tasks, results)
  }

  const entries = await Promise.all(
    tasks.map(async (task) => {
      const canonical = await kv.get(`scheduler:run:${task}:${date}`, 'json') as SchedulerRunLogEntry | null
      if (canonical || !legacyFallback) return canonical
      return await kv.get(`cron:log:${task}:${date}`, 'json') as SchedulerRunLogEntry | null
    }),
  )

  for (const entry of entries) {
    if (entry) results.push(entry)
  }

  return fillMissingSchedulerLogs(tasks, results)
}

function fillMissingSchedulerLogs(tasks: string[], results: SchedulerRunLogEntry[]): SchedulerRunLogEntry[] {
  const loggedTasks = new Set(results.map((row) => row.task))
  for (const task of tasks) {
    if (loggedTasks.has(task)) continue
    results.push({
      task,
      status: 'skipped',
      summary: 'no log for this date',
      duration_ms: 0,
      timestamp: '',
    })
  }

  return results.sort((a, b) => tasks.indexOf(a.task) - tasks.indexOf(b.task))
}

export type CronStatus = SchedulerRunStatus
export type CronLogEntry = SchedulerRunLogEntry
export const isSchedulerStatus = isSchedulerRunStatus
export const classifySchedulerSummary = classifySchedulerRunSummary
export const logSchedulerResult = logSchedulerRunResult
export const getSchedulerLogs = getSchedulerRunLogs
export const isCronStatus = isSchedulerRunStatus
export const classifyCronSummary = classifySchedulerRunSummary
export const logCronResult = logSchedulerRunResult
export const getCronLogs = getSchedulerRunLogs
