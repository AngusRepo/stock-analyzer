import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { alertScreenerChipStale, screenerChipFreshness, type CanonicalScreenerChip } from './screenerMarketData'

const chip = (date: string, name: string): CanonicalScreenerChip =>
  ({ date, stock_id: '2330', name, buy: 1, sell: 0, source: 'fixture' }) as CanonicalScreenerChip
const sessions = ['2026-10-26', '2026-10-27', '2026-10-28']

/** KV + legacy ops DB that records system_logs inserts; any fetch and console.warn are recorded too. */
function alertEnv(t: any, options: { webhook?: boolean, syslogFails?: boolean } = {}) {
  const store = new Map<string, string>()
  const syslogs: { level: string, cron: string, message: string, meta: any }[] = []
  const DB = { prepare: (sql: string) => { let args: any[] = []; const st: any = {
    bind: (...values: any[]) => { args = values; return st },
    run: async () => {
      assert.match(sql, /INSERT INTO system_logs/)
      if (options.syslogFails) throw new Error('D1_ERROR: ops unavailable')
      syslogs.push({ level: args[0], cron: args[1], message: args[2], meta: args[3] ? JSON.parse(args[3]) : null })
      return { success: true }
    } }; return st } }
  const env: any = {
    KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) } },
    DB, ...(options.webhook === false ? {} : { DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook' }),
  }
  const fetched: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => { fetched.push(String(url)); return new Response(null, { status: 204 }) })
  const warns: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
  return { env, store, syslogs, fetched, warns }
}

test('C28-18: chips are stale when their latest date trails the latest price session', () => {
  const fresh = screenerChipFreshness([chip('2026-10-28', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  assert.deepEqual(fresh, {
    latestInstitutionalChipDate: '2026-10-28', latestBrokerFlowDate: '2026-10-28', priceMaxDate: '2026-10-28',
    institutionalStaleSessions: 0, brokerFlowStaleSessions: 0, staleSessions: 0, stale: false,
  })
  // One session behind (legacy names count as institutional too).
  const behind = screenerChipFreshness([chip('2026-10-27', '外資'), chip('2026-10-28', 'broker_flow')], sessions)
  assert.equal(behind.stale, true)
  assert.equal(behind.institutionalStaleSessions, 1)
  assert.equal(behind.staleSessions, 1)
  // Margin rows are not institutional flow; missing broker flow counts every session.
  const missingBroker = screenerChipFreshness([chip('2026-10-28', 'trust'), chip('2026-10-28', 'margin_balance')], sessions)
  assert.equal(missingBroker.latestBrokerFlowDate, null)
  assert.equal(missingBroker.brokerFlowStaleSessions, 3)
  assert.equal(missingBroker.stale, true)
  assert.equal(screenerChipFreshness([], []).stale, false, 'no price session: nothing to compare')
})

test('C28-18: one ops warn per business date, none when fresh, no Discord, never throws', async (t) => {
  const f = alertEnv(t)
  const stale = screenerChipFreshness([chip('2026-10-27', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  const fresh = screenerChipFreshness([chip('2026-10-28', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  assert.equal(await alertScreenerChipStale(f.env, '2026-10-28', fresh), false)
  assert.equal(f.syslogs.length, 0, 'fresh chips are not reported')
  assert.equal(f.warns.length, 0)
  assert.equal(await alertScreenerChipStale(f.env, '2026-10-28', stale), true)
  assert.equal(await alertScreenerChipStale(f.env, '2026-10-28', stale), false, 'second attempt of the same date is deduplicated')
  assert.equal(f.syslogs.length, 1)
  const message = 'screener chip data stale for 2026-10-28: price session 2026-10-28; institutional chips 2026-10-27 (1 sessions behind); '
    + 'broker flow 2026-10-28 (0 sessions behind); chip scores used the latest available dates; scoring is unchanged'
  assert.deepEqual(f.syslogs[0], { level: 'warn', cron: 'screener-chip-stale', message, meta: { run_date: '2026-10-28', ...stale } })
  assert.deepEqual(f.warns, [`[screener-chip-stale] ${message}`])
  assert.equal(f.store.has('cron:alert:screener-chip-stale:2026-10-28'), true)
  assert.deepEqual(f.fetched, [], 'a configured webhook is not used')
  // Another date is its own alert.
  assert.equal(await alertScreenerChipStale(f.env, '2026-10-29', stale), true)
  assert.equal(f.syslogs.length, 2)
})

test('C28-18: without a Discord webhook the stale warn still reaches the ops log and console.warn', async (t) => {
  const f = alertEnv(t, { webhook: false })
  assert.equal(f.env.DISCORD_WEBHOOK_URL, undefined)
  const stale = screenerChipFreshness([chip('2026-10-28', 'foreign')], sessions)
  assert.equal(await alertScreenerChipStale(f.env, '2026-10-28', stale), true)
  assert.equal(f.syslogs.length, 1)
  assert.match(f.syslogs[0].message, /broker flow missing \(3 sessions behind\)/)
  assert.equal(f.warns.length, 1)
  assert.equal(await alertScreenerChipStale(f.env, '2026-10-28', stale), false)
  assert.equal(f.syslogs.length, 1)
  assert.equal(f.warns.length, 1)
  assert.deepEqual(f.fetched, [])
})

test('C28-18: a failing ops log or KV returns false without throwing and still warns', async (t) => {
  const stale = screenerChipFreshness([chip('2026-10-27', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  const failingDb = alertEnv(t, { webhook: false, syslogFails: true })
  // writeSystemLog swallows the insert error: the date is claimed and warned once.
  assert.equal(await alertScreenerChipStale(failingDb.env, '2026-10-28', stale), true)
  assert.equal(failingDb.syslogs.length, 0)
  assert.equal(failingDb.warns.filter((line) => line.startsWith('[screener-chip-stale]')).length, 1)
  const failingKv = alertEnv(t, { webhook: false })
  failingKv.env.KV.get = async () => { throw new Error('KV unavailable') }
  assert.equal(await alertScreenerChipStale(failingKv.env, '2026-10-28', stale), false)
  assert.equal(failingKv.syslogs.length, 0)
  assert.ok(failingKv.warns.some((line) => /^\[screener-chip-stale\] .*; ops log failed: KV unavailable$/.test(line)))
  // An ops binding that cannot be resolved throws (unlike a failed insert) and is swallowed too.
  const missingOps = alertEnv(t, { webhook: false })
  missingOps.env.MULTI_D1_ACTIVE_DOMAINS = 'ops'
  assert.equal(await alertScreenerChipStale(missingOps.env, '2026-10-28', stale), false)
  assert.equal(missingOps.syslogs.length, 0)
  assert.ok(missingOps.warns.some((line) => /^\[screener-chip-stale\] .*; ops log failed: data_domain_binding_missing:ops$/.test(line)))
})

test('C28-18: freshness is observability only and never reaches chip scoring', () => {
  const screener = readFileSync('src/lib/marketScreener.ts', 'utf8')
  const uses = screener.split('\n').filter((line) => /chipFreshness/.test(line)).map((line) => line.trim())
  assert.deepEqual(uses, [
    "import { loadMarketDataFromD1, type CanonicalScreenerChip, type CanonicalScreenerPrice, type ScreenerChipFreshness } from './screenerMarketData'",
    'let chipFreshness: ScreenerChipFreshness | null = null',
    'chipFreshness = marketData.chipFreshness',
    'debugLog.push(`[Data] chip_freshness=${JSON.stringify(chipFreshness)}`)',
    'chipFreshness,',
  ].filter((line) => /chipFreshness/.test(line)))
  // The job has no webhook: it never sends the warn itself (the Worker watchdog does).
  assert.ok(!screener.includes('alertScreenerChipStale'))
  // The audit that flips status is untouched by freshness.
  const auditStart = screener.indexOf('l0RawSignalCoverageAudit.warnings')
  assert.ok(auditStart < 0 || !screener.slice(auditStart - 400, auditStart + 400).includes('chipFreshness'))
  // The funnel carries it only as metadata, next to restrictedCount.
  assert.match(screener, /restrictedCount: punishedSet\.size,\n\s+chipFreshness,/)
})

test('C28-18: the Worker watchdog sends the stale warn once from the canonical funnel metadata', async (t) => {
  const { alertScreenerChipStaleFromFunnel } = await import('./screenerRecoveryWatchdog')
  const rows = new Map<string, string | null>()
  const opsDb: any = { prepare: (sql: string) => { let args: any[] = []; const st: any = {
    bind: (...a: any[]) => { args = a; return st },
    first: async () => { assert.match(sql, /SELECT metadata FROM screener_funnel_runs WHERE date=\? AND run_id=\?/)
      return rows.has(args[1]) ? { metadata: rows.get(args[1]) } : null } }; return st } }
  const f = alertEnv(t, { webhook: false })
  const env = f.env
  const stale = screenerChipFreshness([chip('2026-10-27', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  const fresh = screenerChipFreshness([chip('2026-10-28', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  rows.set('fresh', JSON.stringify({ restrictedCount: 0, chipFreshness: fresh }))
  rows.set('stale', JSON.stringify({ restrictedCount: 0, chipFreshness: stale }))
  rows.set('legacy', JSON.stringify({ restrictedCount: 0 }))
  rows.set('broken', '{not json')
  for (const id of ['fresh', 'legacy', 'broken', 'missing']) assert.equal(await alertScreenerChipStaleFromFunnel(env, opsDb, '2026-10-28', id), false, id)
  assert.equal(await alertScreenerChipStaleFromFunnel(env, opsDb, '2026-10-28', 'stale'), true)
  // Every later watchdog tick of the same date is deduplicated.
  assert.equal(await alertScreenerChipStaleFromFunnel(env, opsDb, '2026-10-28', 'stale'), false)
  assert.deepEqual(f.syslogs.map((entry) => [entry.cron, entry.meta.run_date]), [['screener-chip-stale', '2026-10-28']])
  assert.equal(f.warns.length, 1)
  assert.deepEqual(f.fetched, [])
  const watchdog = readFileSync('src/lib/screenerRecoveryWatchdog.ts', 'utf8')
  assert.ok(watchdog.includes('  if (funnel?.run_id) {\n    await alertScreenerChipStaleFromFunnel(env, opsDb, businessDate, funnel.run_id)'))
})

test('C28-18: chip_score and ranking are byte-identical whether the stale alert fires or not', async (t) => {
  const { scoreMultiFactor } = await import('./marketScreener')
  const days = Array.from({ length: 25 }, (_, i) => new Date(Date.UTC(2026, 8, 21 + i)).toISOString().slice(0, 10))
  const prices = (id: string, drift: number) => days.map((date, i) => ({ date, stock_id: id, Trading_Volume: 2e6 + i * 1e4,
    Trading_money: 1e8, open: 100 + i * drift, max: 101 + i * drift, min: 99 + i * drift, close: 100.5 + i * drift,
    spread: drift, Trading_turnover: 1000 }))
  const universe = { '2330': prices('2330', 0.4), '2317': prices('2317', 0.1), '1101': prices('1101', -0.2) }
  // Chips end one session before the last price session: stale by one.
  const chips = new Map(Object.keys(universe).map((id, n) => [id, new Map(days.slice(0, -1).slice(-6).map((date, i) =>
    [date, { foreign: (n + 1) * 1000 * (i - 2), trust: 500 * n, dealer: 100, brokerFlow: 200 * i }]))]))
  const allChips: CanonicalScreenerChip[] = [...chips].flatMap(([id, byDate]) => [...byDate.keys()].map((date) =>
    ({ date, stock_id: id, name: 'foreign', buy: 1, sell: 0 }) as CanonicalScreenerChip))
  const score = () => Object.entries(universe)
    .map(([id, rows]) => ({ id, ...scoreMultiFactor(rows, chips.get(id), 0.01, rows.at(-1)!.close) }))
    .sort((a, b) => b.base_score - a.base_score || a.id.localeCompare(b.id))
  const before = JSON.stringify(score())
  const inputs = JSON.stringify({ universe, chips: [...chips].map(([id, m]) => [id, [...m]]), allChips })

  const freshness = screenerChipFreshness(allChips, days)
  assert.equal(freshness.stale, true)
  const f = alertEnv(t)
  assert.equal(await alertScreenerChipStale(f.env, days.at(-1)!, freshness), true)
  assert.equal(f.syslogs.length, 1)

  assert.equal(JSON.stringify(score()), before, 'scores and ranking are unchanged by the stale path')
  assert.equal(JSON.stringify({ universe, chips: [...chips].map(([id, m]) => [id, [...m]]), allChips }), inputs, 'inputs are not mutated')
  assert.ok(JSON.parse(before).some((row: any) => row.chip_score !== 0), 'fixture exercises chip scoring')
})
