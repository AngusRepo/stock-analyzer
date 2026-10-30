import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { alertScreenerChipStale, screenerChipFreshness, type CanonicalScreenerChip } from './screenerMarketData'

const chip = (date: string, name: string): CanonicalScreenerChip =>
  ({ date, stock_id: '2330', name, buy: 1, sell: 0, source: 'fixture' }) as CanonicalScreenerChip
const sessions = ['2026-10-26', '2026-10-27', '2026-10-28']

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

test('C28-18: one warn per business date, none when fresh, never throws', async (t) => {
  const store = new Map<string, string>()
  const env = {
    KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) } } as any,
    DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook',
  }
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).content); return new Response(null, { status: 204 })
  })
  const stale = screenerChipFreshness([chip('2026-10-27', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  assert.equal(await alertScreenerChipStale(env, '2026-10-28', screenerChipFreshness([chip('2026-10-28', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)), false)
  assert.equal(await alertScreenerChipStale(env, '2026-10-28', stale), true)
  assert.equal(await alertScreenerChipStale(env, '2026-10-28', stale), false, 'second attempt of the same date is deduplicated')
  assert.equal(sent.length, 1)
  assert.match(sent[0], /screener-chip-stale/)
  assert.match(sent[0], /Institutional chips: 2026-10-27 \(1 sessions behind\)/)
  assert.equal(store.has('cron:alert:screener-chip-stale:2026-10-28'), true)
  assert.equal(await alertScreenerChipStale({ ...env, DISCORD_WEBHOOK_URL: undefined }, '2026-10-29', stale), false)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('webhook down') })
  assert.equal(await alertScreenerChipStale(env, '2026-10-30', stale), false)
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
  const store = new Map<string, string>()
  const rows = new Map<string, string | null>()
  const opsDb: any = { prepare: (sql: string) => { let args: any[] = []; const st: any = {
    bind: (...a: any[]) => { args = a; return st },
    first: async () => { assert.match(sql, /SELECT metadata FROM screener_funnel_runs WHERE date=\? AND run_id=\?/)
      return rows.has(args[1]) ? { metadata: rows.get(args[1]) } : null } }; return st } }
  const env: any = { KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) } },
    DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook' }
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).content); return new Response(null, { status: 204 }) })
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
  assert.equal(sent.length, 1)
  assert.match(sent[0], /screener-chip-stale/)
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
  const store = new Map<string, string>()
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }))
  assert.equal(await alertScreenerChipStale({ KV: { get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) } } as any, DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook' },
  days.at(-1)!, freshness), true)

  assert.equal(JSON.stringify(score()), before, 'scores and ranking are unchanged by the stale path')
  assert.equal(JSON.stringify({ universe, chips: [...chips].map(([id, m]) => [id, [...m]]), allChips }), inputs, 'inputs are not mutated')
  assert.ok(JSON.parse(before).some((row: any) => row.chip_score !== 0), 'fixture exercises chip scoring')
})
