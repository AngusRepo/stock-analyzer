/**
 * cronLogger.ts - Cron result persistence and alerting
 */

export type CronStatus = 'success' | 'error' | 'skipped' | 'triggered' | 'running'

export interface CronLogEntry {
  task: string
  status: CronStatus
  summary: string
  details?: string[]
  duration_ms: number
  timestamp: string
  error?: string
}

const TASK_NAMES: Record<string, string> = {
  'pre-market-warmup': 'Pre-market Warmup',
  'ml-warmup': 'ML Warmup',
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
  'weekly-cleanup': 'Weekly Cleanup',
  'weekly-backtest': 'Weekly Backtest/MC',
  'alpha-quality': 'Alpha Quality',
  'weekly-optuna': 'Weekly Optuna',
  'optuna-queue': 'Optuna Queue Processor',
  verify: 'Verify (compat alias)',
}

export function getTaskDisplayName(task: string): string {
  return TASK_NAMES[task] ?? task
}

export function isCronStatus(status: unknown): status is CronStatus {
  return (
    status === 'success' ||
    status === 'error' ||
    status === 'skipped' ||
    status === 'triggered' ||
    status === 'running'
  )
}

export function classifyCronSummary(summary: string): CronStatus {
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
  return 'success'
}

export async function logCronResult(
  kv: KVNamespace,
  task: string,
  result: Omit<CronLogEntry, 'task' | 'timestamp'>,
  env?: { DISCORD_WEBHOOK_URL?: string },
): Promise<void> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const entry: CronLogEntry = {
    task,
    ...result,
    timestamp: new Date().toISOString(),
  }

  try {
    await kv.put(`cron:log:${task}:${today}`, JSON.stringify(entry), { expirationTtl: 7 * 86400 })
  } catch {
    // Cron logging should never break the task itself.
  }

  if (result.status === 'error' && env?.DISCORD_WEBHOOK_URL) {
    const critical = new Set(['pipeline', 'ml-predict', 'ml', 'recommendation', 'morning-setup', 'paper-trade', 'verify-v2'])
    const dedupKey = `cron:alert:${task}:${today}`

    try {
      const already = await kv.get(dedupKey)
      if (!already || critical.has(task)) {
        const displayName = getTaskDisplayName(task)
        const message = [
          `Cron Fail: ${displayName} (\`${task}\`)`,
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

export async function getCronLogs(kv: KVNamespace, date: string): Promise<CronLogEntry[]> {
  const tasks = Object.keys(TASK_NAMES)
  const results: CronLogEntry[] = []

  const entries = await Promise.all(
    tasks.map(async (task) => await kv.get(`cron:log:${task}:${date}`, 'json') as CronLogEntry | null),
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
