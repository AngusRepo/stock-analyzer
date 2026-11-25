import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { buildHardGateSummary } from './recommendationContext'
import { RECOMMENDATION_FUNNEL_RUN_SQL, resolveRecommendationFunnelRun, screenerLogicalRunKey } from './recommendationFunnelRun'
import { summarizeScreenerFunnelRows } from './screenerFunnelEvidence'

const DATE = '2026-11-23'

function opsFixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`
    CREATE TABLE screener_funnel_runs (run_id TEXT PRIMARY KEY, date TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX idx_screener_funnel_runs_date ON screener_funnel_runs(date DESC, created_at DESC);
    CREATE TABLE canonical_run_heads (logical_run_key TEXT PRIMARY KEY, run_id TEXT NOT NULL);
    CREATE TABLE screener_funnel_items (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, date TEXT, symbol TEXT, stage TEXT, decision TEXT, reason_code TEXT, evidence TEXT);
  `)
  const db = {
    prepare(query: string) {
      let args: any[] = []
      const statement = {
        bind(...values: any[]) { args = values; return statement },
        async first<T>() { return (sql.prepare(query).get(...args) ?? null) as T | null },
        async all<T>() { return { results: sql.prepare(query).all(...args) as T[] } },
      }
      return statement
    },
  }
  const run = (runId: string, status: string, createdAt: string, date = DATE) =>
    sql.prepare('INSERT INTO screener_funnel_runs VALUES (?,?,?,?)').run(runId, date, status, createdAt)
  const head = (runId: string, date = DATE) =>
    sql.prepare('INSERT OR REPLACE INTO canonical_run_heads VALUES (?,?)').run(screenerLogicalRunKey(date), runId)
  const item = (runId: string, symbol: string, stage: string, decision: string, evidence: Record<string, unknown>) =>
    sql.prepare('INSERT INTO screener_funnel_items (run_id, date, symbol, stage, decision, reason_code, evidence) VALUES (?,?,?,?,?,?,?)')
      .run(runId, DATE, symbol, stage, decision, 'test', JSON.stringify(evidence))
  return { sql, db, run, head, item }
}

test('a rerun that is still writing (status=error) after a success does not replace the producer run', async () => {
  const f = opsFixture()
  f.run('run-a', 'success', '2026-11-23 10:00:00'); f.head('run-a')
  f.run('run-b', 'error', '2026-11-23 12:00:00')
  assert.deepEqual(await resolveRecommendationFunnelRun(f.db, DATE), { run_id: 'run-a', is_canonical_head: true })
})

test('a failed latest run falls back to the earlier successful run', async () => {
  const f = opsFixture()
  f.run('run-a', 'success', '2026-11-23 10:00:00'); f.head('run-a')
  f.run('run-b', 'error', '2026-11-23 11:00:00')
  f.run('run-c', 'skipped', '2026-11-23 12:00:00')
  assert.equal((await resolveRecommendationFunnelRun(f.db, DATE))?.run_id, 'run-a')
})

test('a successful rerun after success becomes the producer run (and canonical head)', async () => {
  const f = opsFixture()
  f.run('run-a', 'success', '2026-11-23 10:00:00')
  f.run('run-b', 'success', '2026-11-23 12:00:00'); f.head('run-b')
  assert.deepEqual(await resolveRecommendationFunnelRun(f.db, DATE), { run_id: 'run-b', is_canonical_head: true })
})

test('no successful run means no evidence run (unknown), never a failed run', async () => {
  const f = opsFixture()
  f.run('run-a', 'error', '2026-11-23 10:00:00')
  assert.equal(await resolveRecommendationFunnelRun(f.db, DATE), null)
  f.run('run-other-day', 'success', '2026-11-20 10:00:00', '2026-11-20')
  assert.equal(await resolveRecommendationFunnelRun(f.db, DATE), null)
})

test('a canonical head repointed away from the producer run is flagged, producer run still used', async () => {
  const f = opsFixture()
  f.run('run-a', 'success', '2026-11-23 10:00:00')
  f.run('run-b', 'success', '2026-11-23 12:00:00'); f.head('run-a')
  assert.deepEqual(await resolveRecommendationFunnelRun(f.db, DATE), { run_id: 'run-b', is_canonical_head: false })
})

test('L0 verdict comes from the producer run, not from a partial or failed later rerun', async () => {
  const f = opsFixture()
  f.run('run-a', 'success', '2026-11-23 10:00:00'); f.head('run-a')
  f.item('run-a', '2330', 'universe', 'pass', { passed: true, median_daily_traded_value_twd: 2e9 })
  f.item('run-a', '2330', 'scoring', 'pass', {})
  // Later rerun, still writing/failed: dropped 2330 at L0 (e.g. a restriction list update).
  f.run('run-b', 'error', '2026-11-23 12:00:00')
  f.item('run-b', '2330', 'universe', 'drop', { restricted: true, policy: 'hard_block' })

  const run = await resolveRecommendationFunnelRun(f.db, DATE)
  assert.equal(run?.run_id, 'run-a')
  const { results } = await f.db.prepare('SELECT symbol, stage, decision, reason_code, evidence FROM screener_funnel_items WHERE run_id = ? AND symbol IN (?)')
    .bind(run!.run_id, '2330').all<any>()
  const l0 = summarizeScreenerFunnelRows(results).get('2330')?.evidence.layer0_universe_features as Record<string, any>
  assert.equal(l0.universe_passed, true)
  const gate = buildHardGateSummary({
    boardType: 'LISTED', tradabilityTier: 'auto_tradable', recommendationLane: 'tradable',
    eligibleForMl: true, eligibleForPendingBuy: true,
    universePassed: l0.universe_passed, liquidityCapacityPassed: l0.liquidity_capacity_passed,
  })
  assert.equal(gate.hard_blocked, false)
})

test('run resolution SQL is index-backed (no table SCAN)', () => {
  const f = opsFixture()
  const plan = f.sql.prepare(`EXPLAIN QUERY PLAN ${RECOMMENDATION_FUNNEL_RUN_SQL}`).all(screenerLogicalRunKey(DATE), DATE) as Array<{ detail: string }>
  const details = plan.map((row) => row.detail)
  assert(details.some((d) => /SEARCH r USING INDEX idx_screener_funnel_runs_date/.test(d)), details.join(' | '))
  assert(!details.some((d) => /^SCAN (r|h|screener_funnel_runs|canonical_run_heads)\b/.test(d)), details.join(' | '))
})

test('recommendations route reads evidence from the resolved producer run, not the latest created run', () => {
  const route = readFileSync(new URL('../routes/other.ts', import.meta.url), 'utf8')
  assert(route.includes('await resolveRecommendationFunnelRun(databaseForDataDomain(c.env, \'ops\'), date)'))
  assert(route.includes('.bind(recommendationFunnelRun.run_id, ...resultSymbolChunk)'))
  assert(!route.includes('WITH latest_screener_run AS'))
})

test('pipeline summaries in the same response use the same successful run and expose the latest attempt separately', () => {
  const route = readFileSync(new URL('../routes/other.ts', import.meta.url), 'utf8')
  const start = route.indexOf('async function buildDailyPipelineSummaries(')
  const helper = route.slice(start, route.indexOf('type DailyPipelineSectorAggregateRow', start))
  assert(/FROM screener_funnel_runs\s+WHERE date = \?\s+AND status = 'success'\s+ORDER BY created_at DESC\s+LIMIT 1/.test(helper))
  assert(helper.includes('latest_attempt: latestFunnelAttempt'))
  assert(helper.includes('latest_funnel_attempt: latestFunnelAttempt'), 'a date with only failed/writing runs must still expose the attempt')
  assert(route.includes('latest_funnel_attempt: pipelineSummaries.latest_funnel_attempt ?? null'))
})

test('summary run and latest attempt diverge while a rerun is writing; only failed runs yield no summary run', () => {
  const f = opsFixture()
  const summaryRun = `SELECT run_id FROM screener_funnel_runs WHERE date = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1`
  const attempt = `SELECT run_id, status FROM screener_funnel_runs WHERE date = ? ORDER BY created_at DESC LIMIT 1`
  f.run('run-a', 'success', '2026-11-23 10:00:00')
  f.run('run-b', 'error', '2026-11-23 12:00:00')
  assert.equal((f.sql.prepare(summaryRun).get(DATE) as any).run_id, 'run-a')
  assert.deepEqual({ ...(f.sql.prepare(attempt).get(DATE) as any) }, { run_id: 'run-b', status: 'error' })
  const g = opsFixture()
  g.run('run-x', 'error', '2026-11-23 10:00:00')
  assert.equal(g.sql.prepare(summaryRun).get(DATE), undefined)
  assert.equal((g.sql.prepare(attempt).get(DATE) as any).status, 'error')
})
