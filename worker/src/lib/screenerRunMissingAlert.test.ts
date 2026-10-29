import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolveEveningWatchdogBusinessDate } from './eveningWatchdogBusinessDate'
import { manifestRepeatingWindow } from './schedulerManifestGovernance'
import { runScreenerRecoveryWatchdog, screenerMissingAlertTimes } from './screenerRecoveryWatchdog'
import type { Bindings } from '../types'

const date = '2026-10-22' // a Thursday
const at = (clock: string, day = date) => Date.parse(`${day}T${clock}:00+08:00`)

function fixture(t: any) {
  const store = new Map<string, string>([
    [`market:twse_adhoc_closure_check:v1:${date}`, 'open'],
    ['market:twse_holiday_schedule:v2:2026', JSON.stringify({ schemaVersion: 'twse-holiday-schedule-v2', dates: [] })],
  ])
  const KV = {
    async get(key: string, type?: string) { const v = store.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
  const state = { funnel: null as null | { run_id: string } }
  const db = {
    prepare: (sql: string) => {
      const statement: any = {
        bind: () => statement,
        first: async () => (sql.includes('screener_funnel_runs') ? state.funnel : null),
        all: async () => ({ success: true, results: [] }),
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }
      return statement
    },
    batch: async () => [],
  }
  const env = {
    KV, DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook',
    DB: db, CORE_DB: db, MARKET_DB: db, LEARNING_DB: db, OPS_DB: db, EXECUTION_DB: db, PAPER_DB: db, RESEARCH_DB: db,
  } as unknown as Bindings
  const alerts: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(String(url).startsWith('https://discord.invalid'), `unexpected fetch ${url}`)
    alerts.push(JSON.parse(String(init.body)).content)
    return new Response(null, { status: 204 })
  })
  const trigger = async () => { throw new Error('screener must not be triggered without a canonical run') }
  const watchdogAt = async (clock: string, day = date, businessDate = date) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(clock, day) })
    try { return await runScreenerRecoveryWatchdog(env, trigger, businessDate) } finally { t.mock.timers.reset() }
  }
  const chain = (status: string) => store.set(`scheduler:run:evening-chain:${date}`,
    JSON.stringify({ task: 'evening-chain', run_date: date, run_id: `evening-chain:${date}:1`, status }))
  return { env, store, state, alerts, watchdogAt, chain }
}

test('NEW-86: the alert window comes from the FinLab contract cutoff and the scheduler manifest', () => {
  const window = manifestRepeatingWindow('screener-v2-watchdog')
  assert.equal(window.cron, '*/10 13-22 * * 1-5')
  assert.equal(window.label, 'Weekdays 21:00-06:50 / 10m')
  assert.equal(window.lastSameDayTwMinute, 23 * 60 + 50)
  const times = screenerMissingAlertTimes(date)
  assert.equal(times.alertAtMs, at('23:30'), '23:00 contract cutoff + 30 minutes')
  assert.equal(times.finalTickMs, at('23:50'))
  assert.throws(() => manifestRepeatingWindow('screener-v2-watchdog', { timeZone: 'UTC', jobs: [] }), /manifest_repeating_window_invalid/)
  // A per-job timeZone overrides the manifest default.
  const job = { id: 'screener-v2-watchdog', schedule: '*/10 13-22 * * 1-5' }
  assert.throws(() => manifestRepeatingWindow(job.id, { timeZone: 'UTC', jobs: [{ ...job, timeZone: 'Asia/Taipei' }] }), /manifest_repeating_window_invalid/)
  assert.equal(manifestRepeatingWindow(job.id, { timeZone: 'Asia/Taipei', jobs: [{ ...job, timeZone: 'UTC' }] }).label, 'Weekdays 21:00-06:50 / 10m')
  const status = readFileSync('src/lib/schedulerStatus.ts', 'utf8')
  assert.ok(status.includes("schedule: manifestRepeatingWindow('screener-v2-watchdog').label, cron: manifestRepeatingWindow('screener-v2-watchdog').cron"))
})

test('NEW-86: a trading day without a screener run alerts once from 23:30 TW and returns an error summary', async (t) => {
  const f = fixture(t)
  f.chain('error')
  assert.equal(await f.watchdogAt('23:20'), `SKIPPED canonical screener run missing for ${date}`)
  assert.equal(f.alerts.length, 0)
  const summary = await f.watchdogAt('23:30')
  assert.equal(summary, `status=error screener_run_missing:${date} evening_chain=error`)
  assert.equal(f.alerts.length, 1)
  assert.match(f.alerts[0], /screener-v2-missing/)
  assert.match(f.alerts[0], /evening-chain: error/)
  assert.equal(f.store.has(`cron:alert:screener-v2-missing:${date}`), true)
  // The next tick still reports the error but does not alert again.
  assert.equal(await f.watchdogAt('23:40'), summary)
  assert.equal(f.alerts.length, 1)
})

test('NEW-86: holidays and a successful manual funnel never alert', async (t) => {
  const f = fixture(t)
  f.store.set(`holiday:${date}`, 'fixture holiday')
  assert.match(await f.watchdogAt('23:40'), /^SKIPPED canonical screener run missing .*non_trading_day=holiday_kv$/)
  f.store.delete(`holiday:${date}`)
  f.state.funnel = { run_id: 'manual-screener-1' }
  assert.match(await f.watchdogAt('23:40'), /^SKIPPED .*funnel=manual-screener-1 succeeded outside the canonical chain$/)
  assert.equal(f.alerts.length, 0)
})

test('NEW-86: an active evening chain defers the alert to the last same-day tick (23:50 TW)', async (t) => {
  const f = fixture(t)
  for (const status of ['waiting', 'running', 'triggered']) {
    f.chain(status)
    assert.match(await f.watchdogAt('23:40'), new RegExp(`evening-chain=${status}, alert deferred to 23:50 TW$`))
  }
  assert.equal(f.alerts.length, 0)
  f.chain('waiting')
  assert.equal(await f.watchdogAt('23:50'), `status=error screener_run_missing:${date} evening_chain=waiting`)
  assert.equal(f.alerts.length, 1)
  assert.match(f.alerts[0], /evening-chain: waiting/)
})

test('NEW-86: after midnight the evening root selects the prior business date, which is still reported', async (t) => {
  const f = fixture(t)
  f.chain('waiting')
  const nowMs = at('00:10', '2026-10-23')
  const businessDate = await resolveEveningWatchdogBusinessDate(f.env, 'screener-v2-watchdog', undefined, nowMs)
  assert.equal(businessDate, date)
  assert.equal(await f.watchdogAt('00:10', '2026-10-23', businessDate), `status=error screener_run_missing:${date} evening_chain=waiting`)
  assert.equal(f.alerts.length, 1)
})
