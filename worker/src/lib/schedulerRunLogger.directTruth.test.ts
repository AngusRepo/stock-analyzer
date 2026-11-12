import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { getSchedulerRunLogs, logSchedulerRunResult } from './schedulerRunLogger'
import { getSchedulerStatus } from './schedulerStatus'

type Stored = Record<string, unknown>

class FakeKv {
  constructor(private readonly values: Map<string, Stored>) {}

  async get(key: string, type?: string): Promise<any> {
    const value = this.values.get(key) ?? null
    if (type === 'json') return value
    return value == null ? null : JSON.stringify(value)
  }
}

const date = '2026-08-14'
const staleAggregate = {
  task: 'screener',
  status: 'running',
  summary: 'awaiting callback',
  duration_ms: 0,
  timestamp: '2026-08-14T13:00:00.000Z',
  run_date: date,
}
const terminalDirect = {
  task: 'screener',
  status: 'success',
  summary: 'universe=600',
  duration_ms: 1200,
  timestamp: '2026-08-14T13:05:00.000Z',
  run_date: date,
}

async function main() {
  {
    const kv = new FakeKv(new Map<string, Stored>([
      [`scheduler:run:daily:${date}`, { screener: staleAggregate }],
      [`scheduler:run:screener:${date}`, terminalDirect],
    ]))
    const rows = await getSchedulerRunLogs(kv as any, date)
    const screener = rows.find((row) => row.task === 'screener')
    assert.equal(screener?.status, 'success')
    assert.equal(screener?.summary, 'universe=600')
  }

  {
    const kv = new FakeKv(new Map<string, Stored>([
      [`scheduler:run:daily:${date}`, { screener: staleAggregate }],
      [`scheduler:run:screener:${date}`, terminalDirect],
    ]))
    const rows = await getSchedulerRunLogs(kv as any, date, { directFallback: false })
    const screener = rows.find((row) => row.task === 'screener')
    assert.equal(screener?.status, 'running')
  }

  {
    const legacyOnly = {
      ...terminalDirect,
      task: 'pipeline',
      summary: 'legacy canonical fallback',
    }
    const kv = new FakeKv(new Map<string, Stored>([
      [`cron:log:pipeline:${date}`, legacyOnly],
    ]))
    const rows = await getSchedulerRunLogs(kv as any, date)
    assert.equal(rows.find((row) => row.task === 'pipeline')?.summary, 'legacy canonical fallback')
  }

  {
    const waiting = {
      task: 's12-replay-backfill',
      status: 'running',
      summary: 'coverage=517/520 mature_missing=1 pending_maturity=2 waiting_for_replay_maturity=2',
      duration_ms: 0,
      timestamp: '2026-08-22T06:02:24.313Z',
      run_date: date,
    }
    const kv = new FakeKv(new Map<string, Stored>([
      [`scheduler:run:s12-replay-backfill:${date}`, waiting],
    ]))
    const rows = await getSchedulerRunLogs(kv as any, date)
    assert.equal(rows.find((row) => row.task === 's12-replay-backfill')?.status, 'skipped')
  }

  {
    const coordinatorReceipt = {
      task: 'data-domain-shadow-backfill-next',
      status: 'success',
      summary: 'data_domain_shadow_backfill_next all_domains_caught_up=true',
      duration_ms: 4852,
      timestamp: '2026-08-31T16:30:05.380Z',
      run_date: date,
    }
    const directWorkerReceipt = {
      task: 'data-domain-shadow-backfill',
      status: 'skipped',
      summary: 'domain=ops last_batch_rows=0 status=complete',
      duration_ms: 0,
      timestamp: '2026-08-31T16:00:00.000Z',
      run_date: date,
    }
    const kv = new FakeKv(new Map<string, Stored>([
      [`scheduler:run:data-domain-shadow-backfill-next:${date}`, coordinatorReceipt],
      [`scheduler:run:data-domain-shadow-backfill:${date}`, directWorkerReceipt],
    ]))
    const rows = await getSchedulerRunLogs(kv as any, date)
    assert.equal(
      rows.find((row) => row.task === 'data-domain-shadow-backfill-next')?.summary,
      coordinatorReceipt.summary,
      'the coordinator all-domains-caught-up receipt must survive canonical registry filtering',
    )
    assert.equal(
      rows.find((row) => row.task === 'data-domain-shadow-backfill')?.summary,
      directWorkerReceipt.summary,
      'the coordinator receipt must not overwrite the direct worker receipt',
    )
  }

  console.log('schedulerRunLogger direct truth tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })

test('strict logging survives a rate-limited daily aggregate: per-task keys are the guarantee', async () => {
  const values = new Map<string, string>()
  const kv = {
    get: async (key: string, type?: string) => {
      const value = values.get(key)
      return value == null ? null : type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => {
      if (key.startsWith('scheduler:run:daily:')) throw new Error('KV PUT failed: 429 Too Many Requests')
      values.set(key, value)
    },
  }
  await logSchedulerRunResult(kv as any, 'evening-chain', {
    status: 'success', summary: 'root closed', duration_ms: 1, run_date: date, strict: true,
  })
  assert.equal(JSON.parse(values.get(`scheduler:run:evening-chain:${date}`)!).status, 'success')
  assert.equal(JSON.parse(values.get(`cron:log:evening-chain:${date}`)!).status, 'success')
  assert.equal(values.has(`scheduler:run:daily:${date}`), false)
})

test('scheduler status keeps both of two concurrent same-day logs when the aggregate RMW loses one', async () => {
  const today = '2026-11-12'
  const nowMs = Date.parse('2026-11-12T14:00:00Z')
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE pipeline_stage_runs (
    business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT,
    processed_count INTEGER DEFAULT 0,persisted_count INTEGER DEFAULT 0,expected_count INTEGER,
    attempt_count INTEGER DEFAULT 0,queued_at TEXT,started_at TEXT,completed_at TEXT,
    lease_owner TEXT,lease_expires_at TEXT,last_error TEXT,updated_at TEXT,
    PRIMARY KEY(business_date,stage))`)
  sql.exec(fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  const statement = (query: string, args: any[] = []): any => ({
    bind: (...v: any[]) => statement(query, v),
    all: async () => ({ success: true, results: sql.prepare(query).all(...args) }),
    first: async () => sql.prepare(query).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
  })
  const db = { prepare: statement }
  const values = new Map<string, string>()
  let aggregateReads = 0
  let releaseReads: () => void = () => {}
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve })
  const kv = {
    get: async (key: string, type?: string) => {
      const value = values.get(key)
      if (key === `scheduler:run:daily:${today}` && aggregateReads < 2) {
        // Both writers read the aggregate before either writes it back.
        if (++aggregateReads === 2) releaseReads()
        await bothRead
      }
      return value == null ? null : type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => { values.set(key, value) },
    list: async () => ({ keys: [], list_complete: true }),
  }
  // Both jobs ran yesterday, so a gap in today's aggregate is worth a direct read.
  values.set('scheduler:run:daily:2026-11-11', JSON.stringify(Object.fromEntries(['adapt', 'rescore-10'].map((task) => [task, {
    task, status: 'success', summary: 'ok', duration_ms: 1, run_date: '2026-11-11', timestamp: '2026-11-11T14:00:00.000Z',
  }]))))
  try {
    await Promise.all(['adapt', 'rescore-10'].map((task) => logSchedulerRunResult(kv as any, task, {
      status: 'success', summary: `${task} done`, duration_ms: 1, run_date: today,
    })))
    const aggregate = JSON.parse(values.get(`scheduler:run:daily:${today}`)!)
    assert.equal(Object.keys(aggregate).length, 1, 'fixture reproduces the aggregate lost update')
    const result = await getSchedulerStatus({ DB: db, OPS_DB: db, KV: kv } as any, today, nowMs)
    for (const id of ['adapt', 'rescore-10']) {
      const job = result.jobs.find((row) => row.id === id)!
      assert.equal(job.lastStatus, 'success', `${id} must not read as missing`)
      assert.equal(job.statusRunDate, today)
    }
    // An unreadable per-task key leaves the aggregate's reading instead of failing the page.
    const get = kv.get
    kv.get = async (key: string, type?: string) => {
      if (/^scheduler:run:(adapt|rescore-10):/.test(key)) throw new Error('kv down')
      return get(key, type)
    }
    const degraded = await getSchedulerStatus({ DB: db, OPS_DB: db, KV: kv } as any, today, nowMs)
    const survivor = Object.keys(aggregate)[0]
    assert.equal(degraded.jobs.find((row) => row.id === survivor)!.lastStatus, 'success')
  } finally { sql.close() }
})
