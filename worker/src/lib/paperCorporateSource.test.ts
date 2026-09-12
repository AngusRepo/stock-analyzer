import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { ensurePaperCorporateSource } from './paperCorporateSource'
import { withPaperExecutionScope } from './paperExecutionScope'
import { handleWorkerDomainCron } from './cronWorkerDomainTasks'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'

function fixture() {
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const values = new Map<string, string>(), events: string[] = []
  const snapshot = { schema_version: 'paper-corporate-source-v1', session_date: date,
    observed_at: new Date().toISOString(), source_checksum: 'a'.repeat(64), covered_symbols: ['2330'],
    actions: [], blockers: {}, tax_basis: 'gross_before_personal_tax' }
  const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'fixture',
    DB: { prepare: (sql: string) => { const statement = { bind: (..._: unknown[]) => statement,
      all: async () => ({ success: true, results: sql.includes('paper_positions') ? [{ symbol: '2330' }] : [] }) }
      return statement } },
    KV: { get: async (key: string) => { events.push('read'); return values.get(key) ?? null },
      put: async (key: string, value: string) => { events.push('publish'); values.set(key, value) } } } as any
  const fetcher = async (input: any, init: any) => {
    events.push('fetch')
    assert.equal(input, 'https://controller.invalid/paper/corporate-source')
    assert.deepEqual(JSON.parse(init.body), { session_date: date, scope_id: 'paper-account-1',
      symbols: ['2330'], outstanding_action_ids: [] })
    return Response.json({ snapshot, identity: { session_date: date, scope_id: 'paper-account-1' } })
  }
  return { date, values, events, snapshot, env, fetcher }
}

test('source publication reads back before return and retry never refetches a different revision', async () => {
  const f = fixture(), saved = globalThis.fetch
  globalThis.fetch = f.fetcher as typeof fetch
  try {
    await ensurePaperCorporateSource(f.env, f.date)
    assert.deepEqual(f.events, ['read', 'fetch', 'publish', 'read'])
    await ensurePaperCorporateSource(f.env, f.date)
    assert.equal(f.events.filter(e => e === 'fetch').length, 1)
  } finally { globalThis.fetch = saved }
})

for (const echo of [true, false]) test(`sold holding discovery is sent to the actual controller and requires sealed history echo=${echo}`, async () => {
  const f = fixture(), saved = globalThis.fetch
  const day = new Date(Date.parse(f.date) - 86400_000).toISOString().slice(0, 10)
  const observed = day + 'T00:00:00.000Z'
  const raw = JSON.stringify({ schema_version: 'paper-corporate-opening-basis-v1', account_id: 1,
    session_date: day, observed_at: observed, source_checksum: 'b'.repeat(64),
    positions: [{ account_id: 1, symbol: '2330', shares: 100, avg_cost: 100 }] })
  const event = { id: 1, trade_date: day, detail_json: raw, reason: createHash('sha256').update(raw).digest('hex'),
    source: 'paper_corporate_actions_v1', status: 'recorded', created_at: observed,
    committed_source_checksum: 'b'.repeat(64), processed_at: observed }
  f.env.DB.prepare = (sql: string) => {
    let params: unknown[] = []
    const statement = { bind: (...args: unknown[]) => { params = args; return statement },
      all: async () => ({ success: true, results: sql.includes('paper_execution_events') && params[3] === 0 ? [event] : [] }) }
    return statement
  }
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body))
    assert.deepEqual(request, { session_date: f.date, scope_id: 'paper-account-1', symbols: ['2330'],
      outstanding_action_ids: [], historical_cash_dates: { '2330': [day] } })
    return Response.json({ snapshot: f.snapshot, identity: { session_date: f.date, scope_id: 'paper-account-1' },
      ...(echo ? { request } : {}) })
  }) as typeof fetch
  try {
    if (echo) {
      await ensurePaperCorporateSource(f.env, f.date)
      assert.equal(f.values.size, 1)
    } else {
      await assert.rejects(ensurePaperCorporateSource(f.env, f.date), /receipt_history_mismatch/)
      assert.equal(f.values.size, 0)
    }
  } finally { globalThis.fetch = saved }
})

test('publication outage does not enter actual morning settlement or pending-buy setup', async () => {
  const f = fixture(), saved = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('fixture_source_outage') }) as typeof fetch
  let task: Promise<string> | undefined, settled = false
  try {
    await handleWorkerDomainCron({ cron: '15 23 * * SUN-THU', env: f.env, ctx: {} as any,
      twTodayStr: f.date, runWithLog: (_, run) => { task = run() },
      settlePaperT2: async () => { settled = true }, runPreMarketWarmup: async () => '',
      runIntradayHeartbeat: async () => {}, runIntradayRescore: async () => '' })
    await assert.rejects(task!, /fixture_source_outage/)
    assert.equal(settled, false)
    assert.equal(f.values.size, 0)
  } finally { globalThis.fetch = saved }
})

test('a private execution scope cannot publish a shared formal source key', async () => {
  const f = fixture()
  await assert.rejects(withPaperExecutionScope({ environment: f.env, accountId: 1,
    databases: { paper: f.env.DB }, nowMs: Date.now(), fetchFrozen: async () => { throw new Error('forbidden') } },
    () => ensurePaperCorporateSource(f.env, f.date)), /private_corporate_source_publish_forbidden/)
  assert.equal(f.events.length, 0)
})

test('actual GCP admin morning handler requires source before any formal settlement or pending setup', async () => {
  const f = fixture(), saved = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('fixture_actual_gcp_source_outage') }) as typeof fetch
  let setup = false
  try {
    const tasks = buildAdminWorkerDomainTaskMap({ env: f.env, req: { query: () => undefined } }, {
      setupMorningPendingBuys: async () => { setup = true },
    } as any)
    await assert.rejects(tasks['morning-setup'](), /fixture_actual_gcp_source_outage/)
    assert.equal(setup, false)
    assert.equal(f.values.size, 0)
  } finally { globalThis.fetch = saved }
})

test('actual GCP paired tick cannot translate a failed controller result into success', async () => {
  const f = fixture(), saved = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(input, 'https://controller.invalid/paper/native-execution-tick')
    assert.deepEqual(JSON.parse(String(init?.body)), { session_date: f.date })
    return Response.json({ status: 'failed', pairs: [] })
  }) as typeof fetch
  try {
    const tasks = buildAdminWorkerDomainTaskMap({ env: f.env, req: { query: () => undefined } }, {} as any)
    await assert.rejects(tasks['paired-native-execution'](), /paired_native_execution_tick_failed/)
  } finally { globalThis.fetch = saved }
})
