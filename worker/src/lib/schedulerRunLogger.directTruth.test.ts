import assert from 'node:assert/strict'
import { getSchedulerRunLogs } from './schedulerRunLogger'

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
