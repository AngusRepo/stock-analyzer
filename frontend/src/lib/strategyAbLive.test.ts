import assert from 'node:assert/strict'
import test from 'node:test'
import { alignStrategyAb } from './strategyAbLive'
import type { NavComparisonDetail } from './navTradingRoom'

function pair(role: 'A' | 'B'): NavComparisonDetail {
  return { status: 'available', pair_id: role, as_of: '2026-09-22', history_truncated: false,
    initial_nav: 100000, initial_session_date: '2026-09-21', baseline_checksum: 'same-baseline',
    strategy_ab: { schema_version: 'strategy-ab-price-threehead-exo-mlp-v1', experiment_id: 'a'.repeat(64), role,
      recipe: role === 'A' ? 'price_timexer_three_head' : 'exo137_timexer_three_head_scalar_ev_mlp',
      fee_terms: { discount_factor: .25, minimum_net_commission: 20, nominal_next_month_day: 10,
        cash_credit: 'confirmed_receipt_only', tax_and_slippage_rebated: false } },
    history: ['2026-09-21', '2026-09-22'].map(date => ({ date, candidate_nav: 101000, baseline_nav: 100000,
      candidate_return: .005, baseline_return: 0, net_return_delta: .005, candidate_estimated_nav_including_rebate: 101020 })),
    latest: { date: '2026-09-22', candidate: { nav: 101000, estimated_nav_including_rebate: 101020 } as never, baseline: {} as never, receipt_status: 'verified', fills: null }, blockers: [] }
}
test('A/B live comparison uses verified common initial capital and receivable, not day-one rebasing', () => {
  const result = alignStrategyAb(pair('A'), pair('B'))
  assert.equal(result.aligned, true)
  assert.ok(Math.abs(result.history[0].A - .0102) < 1e-12)
})
for (const fault of ['start', 'capital', 'missing-day', 'experiment', 'receipt', 'rebate', 'role', 'latest-nav', 'latest-rebate', 'latest-receipt']) {
  test(`A/B refuses misleading comparison when ${fault} differs`, () => {
    const a = pair('A'), b = pair('B')
    if (fault === 'start') b.initial_session_date = '2026-09-20'
    if (fault === 'capital') b.initial_nav = 200000
    if (fault === 'missing-day') b.history.shift()
    if (fault === 'experiment') b.strategy_ab!.experiment_id = 'b'.repeat(64)
    if (fault === 'receipt') b.blockers.push('execution_receipt_invalid')
    if (fault === 'rebate') b.history[0].candidate_estimated_nav_including_rebate = null
    if (fault === 'latest-nav') b.latest!.candidate.nav = null
    if (fault === 'latest-rebate') b.latest!.candidate.estimated_nav_including_rebate = null
    if (fault === 'latest-receipt') b.latest!.receipt_status = 'missing'
    if (fault === 'role') b.strategy_ab!.role = 'A'
    assert.equal(alignStrategyAb(a, b).aligned, false)
  })
}
