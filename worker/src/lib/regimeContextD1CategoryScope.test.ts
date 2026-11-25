import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildMarketDashboardMaterializationCheck } from './dataQualityMonitor'
import { finLabRegimeContextD1CategoryScope, finLabRegimeContextScopePredicate } from './finlabSourceContract'

// The reader predicate before d1_category_scope moved into data/finlab_source_contract.json.
const LEGACY_PREDICATE = `(
  dataset NOT IN ('tw_taifex_futures_large_trader', 'tw_taifex_option_large_trader')
  OR category LIKE '%臺股期貨%' OR category LIKE '%台股期貨%' OR category LIKE '%TX+MTX%'
  OR category LIKE '%台指%' OR category LIKE '%臺指%'
)`

const ROWS: Array<[string, string]> = [
  ['tw_taifex_futures_large_trader', '臺股期貨(TX+MTX/4+TMF/20) / 所有契約'],
  ['tw_taifex_futures_large_trader', '臺股期貨(TX+MTX/4+TMF/20) / 週契約'],
  ['tw_taifex_futures_large_trader', '萬海期貨 / 所有契約'],
  ['tw_taifex_futures_large_trader', '澳幣兌美元期貨 / 202612'],
  ['tw_taifex_futures_large_trader', 'market'],
  ['tw_taifex_option_large_trader', '臺指 / 買權 / 所有契約'],
  ['tw_taifex_option_large_trader', '鴻海 / 賣權 / 202612'],
  ['tw_option_put_call_ratio', 'market'],
  ['world_index', 'USDTWD'],
]

function selected(where: string, binds: string[]): string[] {
  const sql = new DatabaseSync(':memory:')
  sql.exec('CREATE TABLE canonical_regime_context_daily (date TEXT, dataset TEXT, category TEXT)')
  const insert = sql.prepare("INSERT INTO canonical_regime_context_daily VALUES ('2026-11-24', ?, ?)")
  for (const [dataset, category] of ROWS) insert.run(dataset, category)
  return sql.prepare(`SELECT dataset || '|' || category AS k FROM canonical_regime_context_daily WHERE ${where} ORDER BY k`)
    .all(...binds).map((row) => String((row as { k: string }).k))
}

test('regime context reader selects exactly the categories the materializer keeps in D1', () => {
  const scope = finLabRegimeContextD1CategoryScope()
  assert.deepEqual(Object.keys(scope).sort(), ['tw_taifex_futures_large_trader', 'tw_taifex_option_large_trader'])
  const predicate = finLabRegimeContextScopePredicate()
  const kept = selected(predicate.sql, predicate.binds)
  assert.deepEqual(kept, selected(LEGACY_PREDICATE, []))
  assert.deepEqual(kept, [
    'tw_option_put_call_ratio|market',
    'tw_taifex_futures_large_trader|臺股期貨(TX+MTX/4+TMF/20) / 所有契約',
    'tw_taifex_futures_large_trader|臺股期貨(TX+MTX/4+TMF/20) / 週契約',
    'tw_taifex_option_large_trader|臺指 / 買權 / 所有契約',
    'world_index|USDTWD',
  ])
})

test('large-trader DQ stays ok on the scoped row count (51 rows on the latest date)', () => {
  const check = buildMarketDashboardMaterializationCheck({
    targetDate: '2026-11-24',
    sources: [{
      key: 'large_trader_net',
      label: '期貨大戶淨部位',
      source: 'canonical_regime_context_daily dataset=tw_taifex_futures_large_trader',
      rows: 51,
      latestDate: '2026-11-24',
      warnLagDays: 2,
      failLagDays: 5,
    }],
  })
  assert.equal(check.status, 'ok')
})
