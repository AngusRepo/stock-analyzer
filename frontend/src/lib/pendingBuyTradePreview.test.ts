import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPendingBuyTradeView, type PendingBuyExecutionPreview } from './pendingBuyTradePreview'

const preview: PendingBuyExecutionPreview = {
  s12: { state: 'waiting_15m_completed_bars', reason: 's12_waiting_15m_completed_bars', ready: false, entry_price: null, chase_ceiling: null, checked_at: '2026-09-29 01:52:26' },
  allocator: { action: 'buy', reason: 'l4_target_reconciliation', budget_cap: 60437, target_value: 60437, available_cash: 966998, l5_status: 'pass', l5_reasons: [], s12_hard_veto: false, checked_at: '2026-09-29 01:52:26' },
}

test('waiting S12 shows reference-based estimated shares without claiming an executable price', () => {
  const view = buildPendingBuyTradeView({ ml_entry_price: 405, execution_preview: preview })
  assert.equal(view.entryPrice, null)
  assert.equal(view.referencePrice, 405)
  assert.equal(view.estimatedShares, 149)
  assert.equal(view.quantityBasis, 'reference')
  assert.equal(view.gateReason, '等待 S12 結構成立')
})

test('ready S12 reprices the share estimate', () => {
  const view = buildPendingBuyTradeView({
    ml_entry_price: 405,
    execution_preview: {
      ...preview,
      s12: { ...preview.s12!, ready: true, entry_price: 410, state: 'reaction_ready' },
    },
  })
  assert.equal(view.entryPrice, 410)
  assert.equal(view.estimatedShares, 147)
  assert.equal(view.quantityBasis, 's12')
})

test('L5 veto is distinguished from insufficient capital', () => {
  const view = buildPendingBuyTradeView({
    ml_entry_price: 405,
    execution_preview: {
      ...preview,
      allocator: { ...preview.allocator!, action: 'skip', reason: 'l4_hard_risk_veto', budget_cap: 0, l5_status: 'blocked', l5_reasons: ['stale_l5_quote', 'wide_l5_spread'] },
    },
  })
  assert.equal(view.estimatedShares, null)
  assert.equal(view.budgetCap, 0)
  assert.equal(view.targetValue, 60437)
  assert.equal(view.gateReason, 'L5 即時報價未通過：L5 報價過期、買賣價差過寬')
  assert.equal(view.availableCash, 966998)
})
