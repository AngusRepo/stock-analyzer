/**
 * schedulerRunLogger.ts - Scheduler run result persistence and alerting
 */
import type { R2Bucket } from '../types'

export type SchedulerRunStatus = 'success' | 'error' | 'skipped' | 'triggered' | 'running'

type SchedulerRunLoggerEnv = {
  DISCORD_WEBHOOK_URL?: string
  DB?: D1Database
  ARTIFACTS?: R2Bucket
}

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
  metadata?: Record<string, unknown>
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
  'meta-learning-shadow': 'Meta Learning Shadow',
  'finlab-ai-skill-discovery': 'FinLab AI Skill Discovery',
  'strategy-learning': 'Strategy Learning',
  pipeline: 'Pipeline',
  'backtest-replay': 'Backtest Replay',
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
  'weekly-cleanup': 'Weekly Cleanup',
  'weekly-backtest': 'Weekly Backtest/MC',
  'alpha-quality': 'Alpha Quality',
  'weekly-optuna': 'Weekly Optuna',
  'sector-leaders': 'Sector Leaders',
  'monthly-optuna': 'Monthly Optuna',
  'optuna-queue': 'Optuna Queue Processor',
  'model-artifact-candidate-validation': 'Model Artifact Candidate Validation',
  'model-artifact-validation': 'Model Artifact Validation',
  'parameter-candidate-validation': 'Parameter Candidate Validation',
  'finlab-v4-backfill': 'FinLab V4 Backfill',
  'finlab-primary-continuation': 'FinLab Primary Continuation',
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
  env?: SchedulerRunLoggerEnv,
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
    metadata: result.metadata,
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

  if (env?.DB && env.ARTIFACTS) {
    try {
      const { recordSchedulerRunReportArtifact } = await import('./datasetSnapshots')
      await recordSchedulerRunReportArtifact(env as Required<Pick<SchedulerRunLoggerEnv, 'DB' | 'ARTIFACTS'>>, {
        task,
        status: result.status,
        businessDate: today,
        runId: result.run_id ?? `${task}:${today}:${entry.timestamp}`,
        summary: result.summary,
        durationMs: result.duration_ms,
        error: result.error,
        metadata: result.metadata,
      })
    } catch (error) {
      console.warn(`[schedulerRunLogger] scheduler_report_artifact_failed task=${task}:`, error)
      if (result.strict) throw error
    }
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

function schedulerReportKindForTask(task: string): string {
  return `${task.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_run_report`
}

function schedulerLogFromReportPayload(
  task: string,
  date: string,
  payload: Record<string, unknown>,
): SchedulerRunLogEntry | null {
  const status = payload.status
  if (!isSchedulerRunStatus(status)) return null

  const metadata = payload.metadata
  return {
    task: String(payload.task || task),
    status,
    summary: String(payload.summary ?? ''),
    duration_ms: Number(payload.duration_ms ?? 0),
    timestamp: String(payload.written_at ?? ''),
    run_id: typeof payload.producer_run_id === 'string' ? payload.producer_run_id : undefined,
    run_date: typeof payload.business_date === 'string' ? payload.business_date : date,
    error: typeof payload.error === 'string' ? payload.error : undefined,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : undefined,
  }
}

async function getSchedulerRunReportArtifactLogs(
  env: SchedulerRunLoggerEnv | undefined,
  date: string,
  missingTasks: string[],
): Promise<SchedulerRunLogEntry[]> {
  if (!env?.DB || !env.ARTIFACTS || missingTasks.length === 0) return []

  const taskByKind = new Map(missingTasks.map((task) => [schedulerReportKindForTask(task), task]))
  const kinds = [...taskByKind.keys()]
  const placeholders = kinds.map(() => '?').join(',')
  const rows = await env.DB.prepare(`
    SELECT kind, r2_key, producer_run_id, created_at, updated_at
    FROM dataset_snapshots
    WHERE business_date = ?
      AND access_tier = 'report'
      AND kind IN (${placeholders})
      AND status = 'ready'
      AND r2_key IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
  `).bind(date, ...kinds).all<{
    kind: string
    r2_key: string | null
    producer_run_id: string
    created_at?: string
    updated_at?: string
  }>()

  const latestByKind = new Map<string, {
    kind: string
    r2_key: string | null
    producer_run_id: string
    created_at?: string
    updated_at?: string
  }>()
  for (const row of rows.results ?? []) {
    if (!latestByKind.has(row.kind)) latestByKind.set(row.kind, row)
  }

  const logs: SchedulerRunLogEntry[] = []
  await Promise.all([...latestByKind.values()].map(async (row) => {
    const task = taskByKind.get(row.kind)
    if (!task || !row.r2_key) return

    const object = await (env.ARTIFACTS as any).get(row.r2_key)
    if (!object) return
    const payload = JSON.parse(await object.text()) as Record<string, unknown>
    const entry = schedulerLogFromReportPayload(task, date, payload)
    if (!entry) return
    logs.push({
      ...entry,
      run_id: entry.run_id ?? row.producer_run_id,
      timestamp: entry.timestamp || row.updated_at || row.created_at || '',
    })
  }))

  return logs
}

export async function getSchedulerRunLogs(
  kv: KVNamespace,
  date: string,
  env?: SchedulerRunLoggerEnv,
): Promise<SchedulerRunLogEntry[]> {
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
  const artifactLogs = await getSchedulerRunReportArtifactLogs(
    env,
    date,
    tasks.filter((task) => !loggedTasks.has(task)),
  )
  for (const entry of artifactLogs) {
    if (loggedTasks.has(entry.task)) continue
    results.push(entry)
    loggedTasks.add(entry.task)
  }

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
