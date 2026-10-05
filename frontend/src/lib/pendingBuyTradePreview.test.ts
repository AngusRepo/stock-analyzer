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

test('A owner ignores stale S12 price and explains its own wait', () => {
  const view = buildPendingBuyTradeView({ ml_entry_price: 48, execution_preview: {
    ...preview,
    entry_owner: 'or15_vwap_v1',
    s12: { ...preview.s12!, ready: true, entry_price: 49, chase_ceiling: 50 },
    or15: { action: 'defer', reason: 'or15_waiting_breakout', or_high: 52, or_low: 51, vwap: 51.33,
      latest_bar_ms: 1790818200000, bar_source: 'shioaji_research_current_session', bar_error: null, checked_at: '2026-10-01 01:31:15' },
  } })
  assert.equal(view.entryPrice, null)
  assert.equal(view.referencePrice, 48)
  assert.equal(view.gateReason, '等待收盤價突破開盤 15 分鐘高點，且站上 VWAP')
  assert.equal(view.checkedAt, '2026-10-01 01:31:15')
})

test('swing owner never shows stale S12 price and distinguishes relative-strength wait',()=>{
 const view=buildPendingBuyTradeView({ml_entry_price:100,execution_preview:{...preview,
  entry_owner:'or15-5m-orl8-20-v1',s12:{...preview.s12!,ready:true,entry_price:101},
  or15:{action:'defer',reason:'swing_waiting_relative_strength',or_high:102,or_low:99,vwap:101,
    relative_return:-.01,ma60:99,latest_bar_ms:1,bar_source:'fixture',bar_error:null,checked_at:'2026-10-02T01:20:00Z'}}})
 assert.equal(view.entryPrice,null);assert.match(view.gateReason!,/0050/);assert.doesNotMatch(view.gateReason!,/S12/)
})

test('pre 09:20 swing wait says the first five-minute signal is forming', () => {
  const view = buildPendingBuyTradeView({ ml_entry_price: 100, execution_preview: {
    ...preview,
    entry_owner: 'or15-5m-orl8-20-v1',
    or15: { action: 'defer', reason: 'swing_entry_window_not_open', or_high: null, or_low: null,
      vwap: null, latest_bar_ms: null, bar_source: 'unavailable', bar_error: null,
      checked_at: '2026-10-05T01:18:00Z' },
  } })
  assert.match(view.gateReason!, /等待 09:15～09:20/)
})
