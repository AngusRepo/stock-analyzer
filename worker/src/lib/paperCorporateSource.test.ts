import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { ensurePaperCorporateSource } from './paperCorporateSource'
import { withPaperExecutionScope } from './paperExecutionScope'
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

test('a private execution scope cannot publish a shared formal source key', async () => {
  const f = fixture()
  await assert.rejects(withPaperExecutionScope({ environment: f.env, accountId: 1,
    databases: { paper: f.env.DB }, nowMs: Date.now(), fetchFrozen: async () => { throw new Error('forbidden') } },
    () => ensurePaperCorporateSource(f.env, f.date)), /private_corporate_source_publish_forbidden/)
  assert.equal(f.events.length, 0)
})

// Source-before-settlement for the morning owner is covered in premarketEventWork.test.ts.
test('actual GCP paired tick stays disabled and never reaches the controller', async () => {
  const f = fixture(), saved = globalThis.fetch
  let fetched = false
  globalThis.fetch = (async () => { fetched = true; return Response.json({ status: 'failed', pairs: [] }) }) as typeof fetch
  try {
    const tasks = buildAdminWorkerDomainTaskMap({ env: f.env, req: { query: () => undefined } }, {} as any)
    assert.match(String(await tasks['paired-native-execution']()), /disabled_by_single_b_policy/)
    assert.equal(fetched, false)
  } finally { globalThis.fetch = saved }
})
