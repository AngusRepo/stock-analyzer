/**
 * cronLogger.ts — Cron 執行日誌
 *
 * 每個 cron 完成後寫 KV，前端 Bot Dashboard 讀取顯示。
 * Key: cron:log:{task}:{date} → JSON
 * TTL: 7 天自動過期
 */

export interface CronLogEntry {
  task: string
  status: 'success' | 'error' | 'skipped'
  summary: string           // 一句話摘要
  details?: string[]        // 細節清單（展開顯示）
  duration_ms: number
  timestamp: string         // ISO 8601
  error?: string
}

// 2026-04-21 audit: keys must match worker runWithLog(task, …) call sites.
// Entries with red-light mismatch removed (data-update, obsidian-sync was OK
// but now kept as alias since cron schedule also calls it).
const TASK_NAMES: Record<string, string> = {
  // Pipeline chain
  'pre-market-warmup':        'Pre-market Warmup',
  'ml-warmup':                'ML Warmup',
  'pipeline':                 'Pipeline',
  'ml-predict':               'ML Predict',
  'recommendation':           'Daily Recommendation',
  'screener':                 'Screener',
  // Daily
  'us-leading':               'US Leading',
  'news-analyst':             'News Analyst',
  'morning-setup':            'Morning Setup',
  'morning-briefing':         'Morning Briefing',
  'daily-snapshot':           'Daily Snapshot',
  'adapt':                    'Adapt Params',
  'daily-report':             'Daily Report',
  'obsidian-daily':           'Obsidian Notes',
  'obsidian-sync':            'Obsidian Sync',
  'regime-compute':           'HMM Regime',
  'verify-v2':                'Verify (V2 LangGraph)',
  'debate-memory-retention':  'Debate Memory Retention',
  // Intraday
  'intraday-check':           'Limit Buy + SL/TP',
  'intraday-rescore':         'Intraday Re-score',
  'eod-exit':                 'EOD Exit',
  // Weekly / multi-day
  'weekly-audit':             'Weekly Audit',
  'model-ic-tracker':         'Model IC Tracker',
  'weekly-cleanup':           'Weekly Cleanup',
  'weekly-backtest':          'Weekly Backtest/MC',
  'weekly-optuna':            'Weekly Optuna',
  'optuna-queue':             'Optuna Queue Processor',
  // Legacy/compat — keep so old KV entries display nicely
  'verify':                   'Verify (legacy V1)',
}

export function getTaskDisplayName(task: string): string {
  return TASK_NAMES[task] ?? task
}

export async function logCronResult(
  kv: KVNamespace,
  task: string,
  result: Omit<CronLogEntry, 'task' | 'timestamp'>,
  env?: { DISCORD_WEBHOOK_URL?: string },
): Promise<void> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const entry: CronLogEntry = {
    task,
    ...result,
    timestamp: new Date().toISOString(),
  }
  try {
    await kv.put(`cron:log:${task}:${today}`, JSON.stringify(entry), { expirationTtl: 7 * 86400 })
  } catch { /* KV write failure should not block cron */ }

  // 2026-04-17 fix: 5-day silent pipeline fail exposed. Alert on cron error to
  // Discord immediately. Rate-limit 1 alert per task per day to avoid spam on
  // repeated retries. Critical tasks override the dedup (pipeline / ml-predict).
  if (result.status === 'error' && env?.DISCORD_WEBHOOK_URL) {
    const CRITICAL = new Set(['pipeline', 'ml-predict', 'ml', 'recommendation', 'morning-setup', 'paper-trade'])
    const dedupKey = `cron:alert:${task}:${today}`
    try {
      const already = await kv.get(dedupKey)
      if (!already || CRITICAL.has(task)) {
        const displayName = getTaskDisplayName(task)
        const msg = `🚨 **Cron Fail: ${displayName}** (\`${task}\`)\n` +
          `Date: ${today}\n` +
          `Duration: ${(result.duration_ms / 1000).toFixed(1)}s\n` +
          `Summary: ${(result.summary || '').slice(0, 500)}\n` +
          (result.error ? `Error: \`${String(result.error).slice(0, 300)}\`` : '')
        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: msg }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => { /* don't let Discord failure block cron logging */ })
        await kv.put(dedupKey, '1', { expirationTtl: 86400 }).catch(() => {})
      }
    } catch { /* alert dispatch must never block cron */ }
  }
}

/** 讀取指定日期所有 cron log */
export async function getCronLogs(kv: KVNamespace, date: string): Promise<CronLogEntry[]> {
  const tasks = Object.keys(TASK_NAMES)
  const results: CronLogEntry[] = []

  // 平行讀取所有 task 的 log
  const entries = await Promise.all(
    tasks.map(async (task) => {
      const raw = await kv.get(`cron:log:${task}:${date}`, 'json') as CronLogEntry | null
      return raw
    })
  )

  for (const entry of entries) {
    if (entry) results.push(entry)
  }

  // 補上未執行的 task（status = pending）
  const loggedTasks = new Set(results.map(r => r.task))
  for (const task of tasks) {
    if (!loggedTasks.has(task)) {
      results.push({
        task,
        status: 'skipped',
        summary: '尚未執行',
        duration_ms: 0,
        timestamp: '',
      })
    }
  }

  return results.sort((a, b) => {
    const order = Object.keys(TASK_NAMES)
    return order.indexOf(a.task) - order.indexOf(b.task)
  })
}
