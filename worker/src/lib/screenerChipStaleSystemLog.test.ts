import assert from 'node:assert/strict'
import test from 'node:test'
import { screenerChipFreshness, type CanonicalScreenerChip } from './screenerMarketData'
import { alertScreenerChipStaleFromFunnel } from './screenerRecoveryWatchdog'

// 17a: the C28-18 stale warn must stay visible when prod has no Discord webhook.
const sessions = ['2026-10-27', '2026-10-28']
const chip = (date: string, name: string) => ({ date, stock_id: '2330', name, buy: 1, sell: 0 }) as CanonicalScreenerChip

function fixture(metadata: Record<string, string>) {
  const logs: unknown[][] = []
  const store = new Map<string, string>()
  const opsDb: any = { prepare: (sql: string) => { let args: unknown[] = []; const st: any = {
    bind: (...a: unknown[]) => { args = a; return st },
    first: async () => (metadata[String(args[1])] != null ? { metadata: metadata[String(args[1])] } : null),
    run: async () => { assert.match(sql, /INSERT INTO system_logs/); logs.push(args); return { success: true } },
  }; return st } }
  // The ops system log is the env's ops domain (legacy DB binding here), the same database as the funnel read.
  const env: any = { KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) } }, DB: opsDb }
  return { logs, store, opsDb, env }
}

test('17a: a stale chip warn is written once per date to the ops system log without a webhook', async () => {
  const stale = screenerChipFreshness([chip('2026-10-27', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  const fresh = screenerChipFreshness([chip('2026-10-28', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  const f = fixture({ stale: JSON.stringify({ chipFreshness: stale }), fresh: JSON.stringify({ chipFreshness: fresh }) })
  assert.equal(await alertScreenerChipStaleFromFunnel(f.env, f.opsDb, '2026-10-28', 'fresh'), false)
  assert.equal(f.logs.length, 0, 'fresh chips write nothing')
  assert.equal(await alertScreenerChipStaleFromFunnel(f.env, f.opsDb, '2026-10-28', 'stale'), true, 'no webhook: the ops warn is written')
  assert.equal(await alertScreenerChipStaleFromFunnel(f.env, f.opsDb, '2026-10-28', 'stale'), false)
  assert.equal(f.logs.length, 1, 'later watchdog ticks of the same date do not log again')
  const [level, cron, , meta] = f.logs[0] as [string, string, string, string]
  assert.equal(level, 'warn')
  assert.equal(cron, 'screener-chip-stale')
  assert.equal(JSON.parse(meta).run_date, '2026-10-28')
  assert.equal(JSON.parse(meta).institutionalStaleSessions, 1)
})

test('17a: a failing dedup claim never blocks the watchdog and still writes the ops warn', async (t) => {
  const stale = screenerChipFreshness([chip('2026-10-27', 'foreign'), chip('2026-10-28', 'broker_flow')], sessions)
  const f = fixture({ stale: JSON.stringify({ chipFreshness: stale }) })
  f.env.KV.get = async (k: string) => { if (k.startsWith('cron:alert:')) throw new Error('kv down'); return f.store.get(k) ?? null }
  const warns: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
  assert.equal(await alertScreenerChipStaleFromFunnel(f.env, f.opsDb, '2026-10-28', 'stale'), true)
  assert.ok(warns.some((line) => line.startsWith('[screener-chip-stale]')), warns.join('\n'))
  assert.equal(f.logs.length, 1)
  assert.equal(JSON.parse((f.logs[0] as string[])[3]).dedup_unavailable, 'kv down')
})
