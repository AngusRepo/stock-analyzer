import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PairedNavShadow from '../src/components/PairedNavShadow'
import type { PairedNavShadowReadModel } from '../src/lib/pipelineMaturityContract'

// The standalone tsx runner uses classic JSX; Vite uses the automatic runtime.
Object.assign(globalThis, { React })

const data: PairedNavShadowReadModel = {
  status: 'terminal_zero_nav', allocation_context_dates: 2, latest_allocation_context_date: '2026-09-08',
  pairs: [{ pair_id: 'synthetic', sessions: 1, latest_session: '2026-09-08', accounted_sessions: 3,
    unverified_sessions: 2, undefined_return_sessions: 2, zero_nav_sessions: 3,
    latest_accounting_session: '2026-09-10', candidate_checksum: 'c', baseline_checksum: 'b' }],
  promotion_allowed: false, ev_prediction_dates_added: 0, blockers: [],
}
const html = renderToStaticMarkup(<PairedNavShadow data={data} />)
assert.ok(html.includes('已記錄淨值歸零，並非缺少資料'))
assert.ok(html.includes('2 日期初淨值為零'))
assert.ok(html.includes('0/0'))
assert.ok(!html.includes('日未取得完整績效證據'))
const mixed = renderToStaticMarkup(<PairedNavShadow data={{ ...data, status: 'valuation_incomplete',
  pairs: [{ ...data.pairs[0], undefined_return_sessions: 1 }] }} />)
assert.ok(mixed.includes('1 日未取得完整績效證據'))
assert.ok(mixed.includes('1 日期初淨值為零'))
assert.ok(!mixed.includes('NaN'))
assert.ok(renderToStaticMarkup(<PairedNavShadow />).includes('API 尚未提供 NAV 資料'))
const closed = renderToStaticMarkup(<PairedNavShadow data={{ ...data, status: 'historical_comparisons',
  pairs: [{ ...data.pairs[0], lifecycle: { reason: 'comparison_changed', transition_signal_date: '2026-09-10',
    final_session_date: '2026-09-10', successor_pair_id: 'next', changed_fields: ['configuration_checksum'] } }] }} />)
assert.ok(closed.includes('歷史 3 日完整保留'))
assert.ok(closed.includes('也不代表績效不合格'))
assert.ok(closed.includes('後續配對：next'))
assert.ok(html.includes('不推定為候選勝過正式配置'))
for (const owner of ['ensemble', 'l4_alpha_ev', 'allocator_ev_fusion']) {
  const fusion = owner === 'allocator_ev_fusion'
  const role = renderToStaticMarkup(<PairedNavShadow data={{ ...data,
    pairs: [{ ...data.pairs[0], comparison: { owner, kind: fusion ? 'incremental_layer' : 'incumbent_replacement',
      baseline_kind: fusion ? 'exact_frozen_l4_candidate' : 'frozen_incumbent_policy', metadata_sessions: 1 } }] }} />)
  assert.ok(role.includes(fusion ? '不代表勝過現行正式配置' : '觀察替換後的整體效果'))
  assert.ok(!role.includes('尚未附完整比較對象'))
  assert.ok(role.includes('比較類型已標記 1/3 日'))
}
console.log('paired-nav render: known zero / mixed missing / absent API passed')
const route = renderToStaticMarkup(<PairedNavShadow data={{ ...data,
  pairs: [{ ...data.pairs[0], comparison: { owner: 'l15_route', kind: 'route_policy_contrast',
    baseline_kind: 'frozen_incumbent_route', metadata_sessions: 3 } }] }} />)
assert.ok(route.includes('L1.5 候選路由對原路由'))
assert.ok(route.includes('不以路由分數差代替投資績效'))
assert.ok(!route.includes('尚未附完整比較對象'))
for (const [owner, kind, baseline_kind, label] of [
  ['opb_arm_prior', 'allocator_policy_contrast', 'exact_frozen_incumbent_allocator', 'OPB 候選配置對原配置'],
  ['atomic_strategy', 'atomic_strategy_replacement', 'frozen_incumbent_strategy_policy', 'Atomic 候選策略對原策略'],
] as const) {
  const result = renderToStaticMarkup(<PairedNavShadow data={{ ...data, pairs: [{ ...data.pairs[0],
    comparison: { owner, kind, baseline_kind, metadata_sessions: 3 } }] }} />)
  assert.ok(result.includes(label))
  assert.ok(!result.includes('尚未附完整比較對象'))
  assert.ok(result.includes('此區塊不更動正式權重'))
}
