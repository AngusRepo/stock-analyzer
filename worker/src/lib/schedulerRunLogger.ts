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
  run_date?: string
  error?: string
}

type SchedulerRunResultInput = Omit<SchedulerRunLogEntry, 'task' | 'timestamp'> & {
  date?: string
  run_date?: string
  strict?: boolean
}

const TASK_NAMES: Record<string, string> = {
  'pre-market-warmup': 'Pre-market Warmup',
  'evening-chain': 'Evening Chain',
  update: 'Market Data Update',
  'indicator-queue': 'Indicator Queue',
  'ml-warmup': 'ML Warmup',
  'post-pipeline-chain': 'Post Pipeline Chain',
  'post-verify-chain': 'Post Verify Chain',
  'dataset-snapshot-export': 'Dataset Snapshot Export',
  'linucb-reward-ledger': 'LinUCB Reward Ledger',
  'adaptive-meta-policy-replay': 'Adaptive Meta Policy Replay',
  'linucb-multiplier-replay': 'LinUCB Multiplier Replay',
  'meta-learning-shadow': 'Meta Learning Shadow',
  'strategy-learning': 'Strategy Learning',
  pipeline: 'Pipeline',
  'ml-predict': 'ML Predict',
  recommendation: 'Daily Recommendation',
  screener: 'Screener',
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
  'intraday-check': 'Limit Buy + SL/TP',
  'intraday-rescore': 'Intraday Re-score',
  'eod-exit': 'EOD Exit',
  'weekly-audit': 'Weekly Audit',
  'model-ic-tracker': 'Model IC Tracker',
  'finlab-v4-backfill': 'FinLab V4 Backfill',
  'weekly-cleanup': 'Weekly Cleanup',
  'weekly-backtest': 'Weekly Backtest/MC',
  'alpha-quality': 'Alpha Quality',
  'weekly-optuna': 'Weekly Optuna',
  'sector-leaders': 'Sector Leaders',
  'monthly-optuna': 'Monthly Optuna',
  'optuna-queue': 'Optuna Queue Processor',
  'monthly-retrain': 'Monthly Universal Retrain',
  verify: 'Verify (compat alias)',
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
  if (normalized.startsWith('failed') || normalized.startsWith('error')) {
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
  const entry: SchedulerRunLogEntry = {
    task,
    status: result.status,
    summary: result.summary,
    details: result.details,
    duration_ms: result.duration_ms,
    run_id: result.run_id,
    run_date: today,
    error: result.error,
    timestamp: new Date().toISOString(),
  }

  try {
    const payload = JSON.stringify(entry)
    await Promise.all([
      kv.put(`scheduler:run:${task}:${today}`, payload, { expirationTtl: 7 * 86400 }),
      kv.put(`cron:log:${task}:${today}`, payload, { expirationTtl: 7 * 86400 }),
    ])
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

export async function getSchedulerRunLogs(kv: KVNamespace, date: string): Promise<SchedulerRunLogEntry[]> {
  const tasks = Object.keys(TASK_NAMES)
  const results: SchedulerRunLogEntry[] = []

  const entries = await Promise.all(
    tasks.map(async (task) => {
      const canonical = await kv.get(`scheduler:run:${task}:${date}`, 'json') as SchedulerRunLogEntry | null
      if (canonical) return canonical
      return await kv.get(`cron:log:${task}:${date}`, 'json') as SchedulerRunLogEntry | null
    }),
  )

  for (const entry of entries) {
    if (entry) results.push(entry)
  }

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
