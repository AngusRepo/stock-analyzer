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

const TASK_NAMES: Record<string, string> = {
  'morning-setup':    'Morning Setup',
  'intraday-check':   'Limit Buy + SL/TP',
  'screener':         'Screener',
  'eod-exit':         'EOD Exit',
  'daily-snapshot':   'Daily Snapshot',
  'data-update':      'Data Update',
  'ml-predict':       'ML Predict',
  'recommendation':   'Recommendation',
  'verify':           'Verify',
  'us-leading':       'US Leading',
  'weekly-cleanup':   'Weekly Cleanup',
  'ml-warmup':        'ML Warmup',
  'morning-briefing': 'Morning Briefing',
  'daily-report':     'Daily Report',
  'obsidian-daily':   'Obsidian Notes',
}

export function getTaskDisplayName(task: string): string {
  return TASK_NAMES[task] ?? task
}

export async function logCronResult(
  kv: KVNamespace,
  task: string,
  result: Omit<CronLogEntry, 'task' | 'timestamp'>,
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
