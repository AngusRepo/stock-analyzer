import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  buildDataQualityReport,
  DATA_QUALITY_CHIP_READY_MINUTE_TW,
  DATA_QUALITY_EOD_READY_MINUTE_TW,
  DATA_QUALITY_MARKET_DASHBOARD_READY_MINUTE_TW,
  DATA_QUALITY_TECHNICAL_READY_MINUTE_TW,
  resolveDataQualityTargetDates,
} from './dataQualityMonitor'
import { buildDeployGateReport } from './deployGate'
import { dailyReadinessStage } from './opsChainStageCatalog'
import { CHIP_READY_MINUTE_TW, MARKET_DASHBOARD_READY_MINUTE_TW, TECHNICAL_READY_MINUTE_TW } from '../monitoring/dataReadiness'

// Chip data, technical indicators and the market dashboard sources are written by the evening chain (Market update
// 22:50, Indicator queue 23:00), not by the 18:10 close refresh: before their writer's deadline the report judges
// them against the previous trading day, prices against today from 18:30.
const T = '2026-11-24' // Tuesday, a trading day (no holiday key)
const T_PREV = '2026-11-23'
const at = (hhmm: string) => Date.parse(`${T}T${hhmm}:00+08:00`)
const minute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

const DOMAINS = ['core', 'market', 'paper', 'learning', 'execution', 'ops', 'research'] as const

/** Market D1 at 20:00 on T: the close refresh wrote T's prices; chip, technical and the canonical dashboard tables end at T−1. */
function stubDb(latest: Record<string, string>) {
  const rowFor = (sql: string): Record<string, unknown> | null => {
    const table = /MAX\(date\) AS latest_date FROM (stock_prices|chip_data|technical_indicators)\b/.exec(sql)?.[1]
    if (table) return { latest_date: latest[table] }
    if (/COUNT\(\*\) AS count FROM (stock_prices|chip_data|technical_indicators) WHERE date = \?/.test(sql)) return { count: 2000 }
    if (/canonical_|external_evidence_items/.test(sql) && /latest_date/.test(sql)) {
      return { latest_date: latest.dashboard, rows_on_latest: 2000, market_breadth_rows: 2000, turnover_rows: 2000, margin_rows: 2000, short_rows: 2000 }
    }
    // No row (D1 first() on an empty result): e.g. no published alpha roster, the legacy order applies.
    return null
  }
  const statement = (sql: string): any => {
    const self = {
      bind: () => self,
      first: async () => rowFor(sql),
      all: async () => ({ results: [], meta: {} }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    }
    return self
  }
  return { prepare: statement, batch: async () => [] } as unknown as D1Database
}

function stubEnv() {
  const db = stubDb({ stock_prices: T, chip_data: T_PREV, technical_indicators: T_PREV, dashboard: T_PREV })
  const env: Record<string, unknown> = {
    KV: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
    MULTI_D1_ACTIVE_DOMAINS: DOMAINS.join(','),
    MULTI_D1_STRICT: 'true',
    ML_CONTROLLER_URL: 'https://controller.test',
    ML_CONTROLLER_SECRET: 'test-only',
  }
  for (const domain of DOMAINS) env[`${domain.toUpperCase()}_DB`] = db
  env.DB = db
  return env as any
}

async function statusesAt(hhmm: string, date?: string) {
  mock.timers.enable({ apis: ['Date'], now: at(hhmm) })
  try {
    const env = stubEnv()
    const report = await buildDataQualityReport(env, { date })
    const gate = await buildDeployGateReport(env, { date }, { scheduler: Promise.resolve({ stats: { failed24h: 0 } }) })
    const status = (id: string) => report.checks.find((check) => check.id === id)?.status
    const gateStatus = (id: string) => gate.checks.find((check) => check.id === `data_quality.${id}`)?.status
    const ids = ['price_freshness', 'chip_freshness', 'technical_indicator_freshness', 'market_dashboard_materialization']
    assert.deepEqual(ids.map(gateStatus), ids.map(status), 'the deploy gate carries the report checks unchanged')
    return [report.date, ...ids.map(status)]
  } finally {
    mock.timers.reset()
  }
}

test('writer deadlines come from the stage catalog, and the monitoring Worker uses the same minutes', () => {
  assert.equal(DATA_QUALITY_EOD_READY_MINUTE_TW, minute('18:30'))
  assert.equal(DATA_QUALITY_CHIP_READY_MINUTE_TW, minute(dailyReadinessStage('update')!.expectedBy!.tw))
  assert.equal(DATA_QUALITY_TECHNICAL_READY_MINUTE_TW, minute(dailyReadinessStage('indicator-queue')!.expectedBy!.tw))
  assert.equal(DATA_QUALITY_MARKET_DASHBOARD_READY_MINUTE_TW, DATA_QUALITY_CHIP_READY_MINUTE_TW, 'FinLab canonical 22:45 then Market update')
  assert.deepEqual([CHIP_READY_MINUTE_TW, TECHNICAL_READY_MINUTE_TW, MARKET_DASHBOARD_READY_MINUTE_TW],
    [DATA_QUALITY_CHIP_READY_MINUTE_TW, DATA_QUALITY_TECHNICAL_READY_MINUTE_TW, DATA_QUALITY_MARKET_DASHBOARD_READY_MINUTE_TW])
  assert.deepEqual([DATA_QUALITY_CHIP_READY_MINUTE_TW, DATA_QUALITY_TECHNICAL_READY_MINUTE_TW], [22 * 60 + 50, 23 * 60])
})

test('target dates per group: prices at 18:30, the evening-chain data at its writer\'s deadline; a requested date as is', async () => {
  const kv = { get: async () => null } as unknown as KVNamespace
  const targets = (hhmm: string, requested?: string) =>
    resolveDataQualityTargetDates(kv, requested, T, new Date(at(hhmm) + 8 * 3600_000))
  assert.deepEqual(await targets('18:00'), { price: T_PREV, chip: T_PREV, technical: T_PREV, marketDashboard: T_PREV })
  assert.deepEqual(await targets('20:00'), { price: T, chip: T_PREV, technical: T_PREV, marketDashboard: T_PREV })
  assert.deepEqual(await targets('22:50'), { price: T, chip: T, technical: T_PREV, marketDashboard: T })
  assert.deepEqual(await targets('23:00'), { price: T, chip: T, technical: T, marketDashboard: T })
  assert.deepEqual(await targets('20:00', T), { price: T, chip: T, technical: T, marketDashboard: T })
})

test('buildDataQualityReport and the deploy gate: no false lateness between 18:30 and the writer deadlines; real lateness still fails', async () => {
  // Before: from 18:30 chip and technical failed (BLOCK) and the dashboard warned, until the evening chain wrote them.
  assert.deepEqual(await statusesAt('20:00'), [T, 'ok', 'ok', 'ok', 'ok'])
  // Market update's deadline passed without T's chip data / dashboard sources: late for real.
  assert.deepEqual(await statusesAt('22:55'), [T, 'ok', 'fail', 'ok', 'warn'])
  assert.deepEqual(await statusesAt('23:05'), [T, 'ok', 'fail', 'fail', 'warn'])
  // Before 18:30 everything is judged against T−1, as before.
  assert.deepEqual(await statusesAt('17:00'), [T_PREV, 'ok', 'ok', 'ok', 'ok'])
  // A requested date (CD never sends one; the OBS events report sends today) is judged as is, as before.
  assert.deepEqual(await statusesAt('20:00', T), [T, 'ok', 'fail', 'fail', 'warn'])
})
