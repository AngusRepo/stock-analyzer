import { getSchedulerRunLogs, logSchedulerRunResult } from './schedulerRunLogger'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function createMockKv(): KVNamespace & { writes: Map<string, string> } {
  const writes = new Map<string, string>()
  return {
    writes,
    async put(key: string, value: string) {
      writes.set(key, value)
    },
    async get(key: string, type?: string) {
      const value = writes.get(key) ?? null
      if (type === 'json') return value ? JSON.parse(value) : null
      return value
    },
  } as unknown as KVNamespace & { writes: Map<string, string> }
}

void (async () => {
  const originalNow = Date.now
  Date.now = () => Date.parse('2026-06-01T14:00:00.000Z')
  try {
    const kv = createMockKv()
    await logSchedulerRunResult(kv, 'evening-chain', {
      status: 'success',
      summary: 'historical rerun finished',
      duration_ms: 1200,
      run_date: '2026-05-29',
    })

    assert(kv.writes.has('scheduler:run:evening-chain:2026-05-29'), 'business-date scheduler log must still be written')
    assert(kv.writes.has('cron:log:evening-chain:2026-05-29'), 'business-date cron log must still be written')
    assert(kv.writes.has('scheduler:run:evening-chain:executed:2026-06-01'), 'historical rerun must be indexed by operational execution date')
    assert(kv.writes.has('cron:log:evening-chain:executed:2026-06-01'), 'historical rerun cron log must be indexed by operational execution date')

    const logs = await getSchedulerRunLogs(kv, '2026-06-01')
    const evening = logs.find((row) => row.task === 'evening-chain')
    assert(evening?.status === 'success', 'operational-date scheduler read must find historical rerun status')
    assert(evening?.run_date === '2026-05-29', 'operational-date read must preserve original business date')
    assert((evening?.metadata as any)?.operational_date === '2026-06-01', 'operational-date read must expose the execution date')
  } finally {
    Date.now = originalNow
  }
})()
