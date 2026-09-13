import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readNavComparison, rawTopLevelValue } from '../src/lib/navTradingRoom'
import { dashboardReadRoutes } from '../src/routes/dashboardReadRoutes'

async function main() {
  assert.equal(rawTopLevelValue('{"content":{"seed":9007199254740993,"x":1.0,"s":"a\\\"}b"},"z":2}', 'content'), '{"seed":9007199254740993,"x":1.0,"s":"a\\\"}b"}')
  assert.equal(rawTopLevelValue('{"content":"content","next":1}', 'content'), '"content"')
  assert.throws(() => rawTopLevelValue('{"x":1}', 'content'))
  const fixture = process.env.NAV_ORIGINAL_FIXTURE
  assert.ok(fixture, 'requires original Python evaluator evidence, not fabricated UI results')
  const data = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync('domain-migrations/learning/0040_paired_nav_shadow_journal.sql', 'utf8'))
  const tables = ['paired_nav_frozen_parts_v1', 'paired_nav_frozen_manifests_v1', 'paired_nav_daily_journal_v1']
  for (const table of tables) for (const row of data.tables[table]) {
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => row[k]))
  }
  const binding = { prepare(sql: string) {
    assert.match(sql.trim(), /^SELECT/i, 'read API must not mutate')
    let args: any[] = []
    return { bind(...values: any[]) { args = values; return this },
      async all() { return { success: true, results: db.prepare(sql).all(...args) } },
      async first() { return db.prepare(sql).get(...args) ?? null } }
  } } as unknown as D1Database
  const before = db.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all() as any[]
  const pairs = [...new Set(before.map(row => row.pair_id))]
  let verified = 0
  const uiDetails: Record<string, unknown> = {}
  for (const pair of pairs) {
    const originals = before.filter(row => row.pair_id === pair)
    const detail = await readNavComparison(binding, pair, data.now.slice(0, 10))
    uiDetails[pair] = detail
    assert.equal(detail.status, 'available', JSON.stringify(detail))
    assert.equal(detail.history.length, originals.length)
    const latest = JSON.parse(originals[originals.length - 1].payload_json)
    assert.equal(detail.latest?.candidate.nav, latest.arms.candidate.nav)
    assert.equal(detail.latest?.baseline.nav, latest.arms.baseline.nav)
    assert.equal(detail.latest?.candidate.costs, latest.arms.candidate.costs)
    assert.notEqual(detail.latest?.receipt_status, 'invalid', JSON.stringify(detail))
    if (detail.latest?.receipt_status === 'verified') {
      verified++
      assert.equal(detail.latest.fills?.candidate.length, latest.arms.candidate.fill_count)
    }
    const early = await readNavComparison(binding, pair, originals[0].session_date)
    assert.equal(early.history.length, 1)
    assert.equal(early.latest?.date, originals[0].session_date)
    assert.equal((await readNavComparison(binding, pair, '2020-01-01')).status, 'not_found')
  }
  assert.ok(verified > 0, 'original execution receipts must be checked')
  if (process.env.NAV_UI_FIXTURE) {
    fs.writeFileSync(process.env.NAV_UI_FIXTURE, JSON.stringify({ source: 'synthetic Python accounting integration test; NOT production ROI',
      details: uiDetails, list: { status: 'observing', allocation_context_dates: 10, latest_allocation_context_date: data.now.slice(0, 10),
        promotion_allowed: false, ev_prediction_dates_added: 0, blockers: [], pairs: pairs.map(pair => {
          const rows = before.filter(row => row.pair_id === pair), body = JSON.parse(rows[rows.length - 1].payload_json)
          return { pair_id: pair, sessions: rows.length, accounted_sessions: rows.length, unverified_sessions: 0,
            latest_session: body.session_date, latest_accounting_session: body.session_date,
            candidate_checksum: body.pair_identity.candidate_checksum, baseline_checksum: body.pair_identity.baseline_checksum,
            comparison: { ...body.comparison, metadata_sessions: rows.length } }
        }) } }))
  }
  assert.deepEqual(db.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all(), before)
  // Missing receipts and corrupted bytes are injected in query responses only.
  const intercept = (rewrite: (sql: string, rows: any[]) => any[]) => ({ prepare(sql: string) {
    const stmt = binding.prepare(sql)
    return { bind(...args: any[]) { stmt.bind(...args); return this }, async all() {
      const r = await stmt.all<any>(); return { ...r, results: rewrite(sql, r.results) }
    } }
  } }) as unknown as D1Database
  const missing = await readNavComparison(intercept((sql, rows) => sql.includes('FROM paired_nav_frozen_manifests') ? [] : rows), pairs[0], data.now.slice(0, 10))
  assert.equal(missing.status, 'available'); assert.equal(missing.latest?.receipt_status, 'missing'); assert.equal(missing.latest?.fills, null)
  const corrupt = await readNavComparison(intercept((sql, rows) => sql.includes('FROM paired_nav_daily_journal') ? rows.map((r, i) => i ? r : { ...r, payload_json: r.payload_json + ' ' }) : rows), pairs[0], data.now.slice(0, 10))
  assert.equal(corrupt.status, 'unavailable'); assert.equal(corrupt.latest, null)
  const badReceipt = await readNavComparison(intercept((sql, rows) => sql.includes('FROM paired_nav_frozen_parts') ? rows.map(r => ({ ...r, payload_text: r.payload_text + ' ' })) : rows), pairs[0], data.now.slice(0, 10))
  assert.equal(badReceipt.latest?.receipt_status, 'invalid'); assert.equal(badReceipt.latest?.fills, null)
  const noAuth = await dashboardReadRoutes.request('/api/dashboard/v4/nav/comparisons', {}, {} as any)
  assert.equal(noAuth.status, 401)
  const env = { STOCKVISION_AUTH_TOKEN: 'local-test-only', DB: binding } as any
  const auth = { headers: { Authorization: 'Bearer local-test-only' } }
  for (const query of ['date=2026-02-30', 'date=2099-01-01', 'date=garbage']) {
    const invalid = await dashboardReadRoutes.request(`/api/dashboard/v4/nav/comparisons?${query}`, auth, env)
    assert.equal(invalid.status, 400)
  }
  const invalidPair = await dashboardReadRoutes.request('/api/dashboard/v4/nav/comparisons/not-a-pair', auth, env)
  assert.equal(invalidPair.status, 400)
  const http = await dashboardReadRoutes.request(`/api/dashboard/v4/nav/comparisons/${pairs[0]}?date=2026-09-09`, auth, env)
  assert.equal(http.status, 200); assert.equal(http.headers.get('cache-control'), 'no-store, max-age=0')
  assert.equal((await http.json() as any).status, 'available')
  console.log(`NAV room: ${pairs.length} Python-origin pairs, ${verified} verified receipts; history, missing, corruption, read-only and auth checks passed`)
  db.close()
}
main().catch(error => { console.error(error); process.exitCode = 1 })
