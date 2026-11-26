import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { twToday } from './dateUtils'

// One /obs events request must read the scheduler status and the data-quality report once,
// not once more inside the deploy gate. Rows are Miniflare D1 meta.rows_read.
const DOMAINS = ['core', 'market', 'paper', 'learning', 'execution', 'ops', 'research'] as const
const TICKET_SCAN = /SELECT \*\s+FROM scheduler_execution_tickets_v1\s+WHERE business_date IN/
const PRICE_LATEST = /SELECT MAX\(date\) AS latest_date FROM stock_prices/

function domainSchema(domain: string): string[] {
  const sql = new DatabaseSync(':memory:')
  const dir = `domain-migrations/${domain}/`
  // Later core files re-add columns 0001 already has; the duplicate-column error is expected.
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    try { sql.exec(fs.readFileSync(dir + file, 'utf8')) } catch {}
  }
  const rows = sql.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Array<{ sql: string }>
  sql.close()
  return rows.map((row) => row.sql)
}

type Counter = { rows: number; statements: string[] }

function counting(db: any, counter: Counter): any {
  const wrap = (statement: any, query: string): any => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values), query),
    all: async () => {
      const result = await statement.all()
      counter.rows += Number(result.meta?.rows_read ?? 0)
      counter.statements.push(query)
      return result
    },
    // first() runs the same statement and keeps the first row; all() exposes its meta.
    first: async (column?: string) => {
      const result = await statement.all()
      counter.rows += Number(result.meta?.rows_read ?? 0)
      counter.statements.push(query)
      const row = result.results?.[0] ?? null
      return column ? (row?.[column] ?? null) : row
    },
    run: async () => {
      const result = await statement.run()
      counter.rows += Number(result.meta?.rows_read ?? 0)
      counter.statements.push(query)
      return result
    },
    raw: async (options?: any) => {
      counter.statements.push(query)
      return statement.raw(options)
    },
    inner: statement,
  })
  return {
    prepare: (query: string) => wrap(db.prepare(query), query),
    batch: async (statements: any[]) => {
      const results = await db.batch(statements.map((statement) => statement.inner ?? statement))
      for (const result of results) counter.rows += Number(result.meta?.rows_read ?? 0)
      return results
    },
    exec: (query: string) => db.exec(query),
  }
}

async function obsFixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: DOMAINS.map((domain) => `${domain.toUpperCase()}_DB`),
  })
  const raw: Record<string, any> = {}
  for (const domain of DOMAINS) {
    const db = raw[domain] = await mf.getD1Database(`${domain.toUpperCase()}_DB`)
    for (const statement of domainSchema(domain)) await db.prepare(statement).run()
  }
  const today = twToday()
  const days = Array.from({ length: 10 }, (_, index) => new Date(Date.parse(`${today}T00:00:00Z`) - index * 86_400_000).toISOString().slice(0, 10))
  const tickets = []
  for (const date of days) {
    for (let index = 0; index < 40; index++) {
      tickets.push(raw.ops.prepare(`INSERT INTO scheduler_execution_tickets_v1
        (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum)
        VALUES (?,?,?,?,?,?,?,?,'physical_root','success','scheduler_http','x')`)
        .bind(`t-${date}-${index}`, `d-${date}-${index}`, `t-${date}-${index}`, `job-${index}`, `task-${index}`, date, `r-${date}-${index}`, `a-${date}-${index}`))
    }
  }
  await raw.ops.batch(tickets)
  const market = []
  for (const date of days) {
    for (let stock = 1; stock <= 30; stock++) {
      market.push(raw.market.prepare('INSERT INTO stock_prices (stock_id,date,close,volume) VALUES (?,?,100,1000)').bind(stock, date))
      market.push(raw.market.prepare('INSERT INTO chip_data (symbol,date) VALUES (?,?)').bind(String(1000 + stock), date))
      market.push(raw.market.prepare('INSERT INTO technical_indicators (stock_id,date) VALUES (?,?)').bind(stock, date))
    }
  }
  await raw.market.batch(market)

  const counter: Counter = { rows: 0, statements: [] }
  const kvs = new Map<string, string>()
  const env: any = {
    KV: {
      get: async (key: string, type?: string) => { const value = kvs.get(key) ?? null; return type === 'json' && value !== null ? JSON.parse(value) : value },
      put: async (key: string, value: string) => { kvs.set(key, value) },
      delete: async (key: string) => { kvs.delete(key) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    MULTI_D1_ACTIVE_DOMAINS: DOMAINS.join(','),
    MULTI_D1_STRICT: 'true',
  }
  for (const domain of DOMAINS) env[`${domain.toUpperCase()}_DB`] = counting(raw[domain], counter)
  env.DB = env.CORE_DB
  const measure = async <T>(run: () => Promise<T>) => {
    counter.rows = 0
    counter.statements = []
    const value = await run()
    return {
      value,
      rows: counter.rows,
      ticketScans: counter.statements.filter((query) => TICKET_SCAN.test(query)).length,
      priceLatest: counter.statements.filter((query) => PRICE_LATEST.test(query)).length,
    }
  }
  return { env, raw, today, measure, close: () => mf.dispose() }
}

async function withFixture(run: (f: Awaited<ReturnType<typeof obsFixture>>) => Promise<void>) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline fixture') }
  const { clearObsRecentReads } = await import('./obsRecentReads')
  clearObsRecentReads()
  const f = await obsFixture()
  try { await run(f) } finally {
    clearObsRecentReads()
    globalThis.fetch = previousFetch
    await f.close()
  }
}

const SERVICE = { headers: { Authorization: 'Bearer service-token' } }

test('one events request reads scheduler status and data quality once', () => withFixture(async (f) => {
  const { getSchedulerStatus } = await import('./schedulerStatus')
  const { buildDataQualityReport } = await import('./dataQualityMonitor')
  const { buildDeployGateReport } = await import('./deployGate')
  const { buildLiveObservabilityEventReport } = await import('./observabilityEvents')
  const date = f.today
  const scheduler = await f.measure(() => getSchedulerStatus(f.env))
  const quality = await f.measure(() => buildDataQualityReport(f.env, { date }))
  const gate = await f.measure(() => buildDeployGateReport(f.env, { date }))
  const events = await f.measure(() => buildLiveObservabilityEventReport(f.env, { date }))
  console.log(JSON.stringify({ scheduler: scheduler.rows, quality: quality.rows, gate: gate.rows, events: events.rows }))
  assert.ok(scheduler.rows > 400, 'fixture tickets must make the scheduler scan visible')
  assert.equal(scheduler.ticketScans, 1)
  assert.equal(quality.priceLatest, 1)
  assert.equal(gate.ticketScans, 1)
  assert.equal(gate.priceLatest, 1)
  assert.equal(events.ticketScans, 1, 'events must not scan the 7-day tickets again for its deploy gate')
  assert.equal(events.priceLatest, 1, 'events must not rebuild data quality for its deploy gate')
  // Before sharing, events = 2 x (scheduler + quality) + other reads; the deploy gate's own pair is gone.
  assert.ok(events.rows < scheduler.rows * 2, `events rows ${events.rows} must not include a second scheduler scan`)
}))

test('the events deploy gate decides the same as a standalone gate on the same data', () => withFixture(async (f) => {
  const { buildDeployGateReport } = await import('./deployGate')
  const { getSchedulerStatus } = await import('./schedulerStatus')
  const { buildDataQualityReport } = await import('./dataQualityMonitor')
  const date = f.today
  const standalone = await buildDeployGateReport(f.env, { date })
  const shared = await buildDeployGateReport(f.env, { date }, {
    scheduler: getSchedulerStatus(f.env),
    dataQuality: buildDataQualityReport(f.env, { date }),
  })
  assert.equal(shared.decision, standalone.decision)
  assert.deepEqual(shared.checks.map((check) => [check.id, check.status, check.summary]),
    standalone.checks.map((check) => [check.id, check.status, check.summary]))
  const unreadable = await buildDeployGateReport(f.env, { date }, {
    scheduler: Promise.reject(new Error('scheduler down')),
    dataQuality: buildDataQualityReport(f.env, { date }),
  })
  assert.equal(unreadable.checks.find((check) => check.id === 'scheduler_failed_24h')?.status, 'fail',
    'a shared scheduler read that fails still fails the gate')
}))

test('/obs UI polls reuse a recent read; scheduler status and the CD gate read fresh', () => withFixture(async (f) => {
  const { adminReadRoutes } = await import('../routes/adminReadRoutes')
  f.env.STOCKVISION_AUTH_TOKEN = 'service-token'
  const get = (path: string) => f.measure(async () => {
    const response = await adminReadRoutes.request(path, SERVICE, f.env)
    assert.equal(response.status, 200, path)
    return response.json() as Promise<any>
  })

  // Direct scheduler polls always scan; their result warms the UI reuse.
  for (let poll = 0; poll < 2; poll++) assert.equal((await get('/api/scheduler/status')).ticketScans, 1, 'scheduler status must stay fresh')

  const uiEvents = await get('/api/admin/observability/events?cache=ui')
  assert.equal(uiEvents.ticketScans, 0, 'UI events reuse the scheduler read from the direct poll')
  assert.equal(uiEvents.priceLatest, 1)
  assert.equal(uiEvents.value.audit, undefined, 'events no longer reads unused audit rows')
  const uiQuality = await get('/api/admin/data-quality/status?cache=ui')
  const uiPill = await get('/api/admin/gate/predeploy?cache=ui')
  assert.equal(uiPill.ticketScans, 0)
  assert.equal(uiPill.priceLatest, 0, 'the pill reuses the data-quality report the status poll just read')
  console.log(JSON.stringify({ uiEvents: uiEvents.rows, uiQuality: uiQuality.rows, uiPill: uiPill.rows }))

  // New rows on the latest price date after the UI reads are cached.
  const latest = f.today
  await f.raw.market.batch(Array.from({ length: 5 }, (_, index) =>
    f.raw.market.prepare('INSERT INTO stock_prices (stock_id,date,close,volume) VALUES (?,?,100,1000)').bind(100 + index, latest)))
  const priceRows = (report: any) => report.checks.find((check: any) => check.id === 'data_quality.price_freshness')?.metrics?.rows_on_latest

  for (const path of ['/api/admin/gate/predeploy', '/api/admin/gate/predeploy?live=1', '/api/admin/gate/predeploy?live=1&cache=ui']) {
    const gate = await get(path)
    assert.equal(gate.ticketScans, 1, `${path} must scan scheduler tickets itself`)
    assert.equal(gate.priceLatest, 1, `${path} must rebuild data quality itself`)
    assert.equal(priceRows(gate.value), priceRows(uiPill.value) + 5, `${path} must see rows written after the UI read`)
  }
  assert.equal((await get('/api/admin/data-quality/status')).priceLatest, 1, 'the data-quality page reads fresh')
  assert.equal((await get('/api/admin/observability/events')).ticketScans, 1, 'events without cache=ui reads fresh')
}))
