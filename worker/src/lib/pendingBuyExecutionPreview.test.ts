import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPendingBuyExecutionPreviews } from './pendingBuyExecutionPreview'

test('latest S12 and allocator audits form one trading preview', () => {
  const preview = buildPendingBuyExecutionPreviews([
    {
      symbol: '7792', kind: 's12', status: 'waiting_15m_completed_bars',
      reason: 's12_waiting_15m_completed_bars', created_at: '2026-09-29 01:52:26',
      detail_json: JSON.stringify({ state: 'waiting_15m_completed_bars', ready: false, reason: 's12_waiting_15m_completed_bars' }),
    },
    {
      symbol: '7792', kind: 'allocator', status: 'allocator_buy',
      reason: 'l4_target_reconciliation', created_at: '2026-09-29 01:52:26',
      detail_json: JSON.stringify({ detail: 'allocator:buy:l4_target_reconciliation;target=60437;current=0;budget=60437;available_cash=966998;s12_hard_veto=false;l5_status=pass;l5_reasons=' }),
    },
  ]).get('7792')

  assert.equal(preview?.s12?.ready, false)
  assert.equal(preview?.s12?.entry_price, null)
  assert.equal(preview?.allocator?.budget_cap, 60437)
  assert.equal(preview?.allocator?.available_cash, 966998)
  assert.equal(preview?.allocator?.l5_status, 'pass')
  assert.deepEqual(preview?.allocator?.l5_reasons, [])
})

test('S12 entry overlay supplies a dynamic price and chase ceiling', () => {
  const preview = buildPendingBuyExecutionPreviews([{
    symbol: '7822', kind: 's12', status: 'reaction_ready', reason: 's12_reaction_ready',
    created_at: '2026-09-29 02:10:00',
    detail_json: JSON.stringify({ state: 'reaction_ready', ready: true, assist_entry_overlay: { entryPrice: 410, chaseCeiling: 414.5 } }),
  }]).get('7822')

  assert.equal(preview?.s12?.entry_price, 410)
  assert.equal(preview?.s12?.chase_ceiling, 414.5)
})

test('a hard veto preserves zero budget and nonzero available cash', () => {
  const preview = buildPendingBuyExecutionPreviews([{
    symbol: '7822', kind: 'allocator', status: 'allocator_skip', reason: 'l4_hard_risk_veto',
    created_at: '2026-09-29 02:12:25',
    detail_json: JSON.stringify({ detail: 'allocator:skip:l4_hard_risk_veto:target=36262;budget=0;available_cash=966998;l5_status=blocked;l5_reasons=stale_l5_quote|wide_l5_spread' }),
  }]).get('7822')

  assert.equal(preview?.allocator?.budget_cap, 0)
  assert.equal(preview?.allocator?.available_cash, 966998)
  assert.deepEqual(preview?.allocator?.l5_reasons, ['stale_l5_quote', 'wide_l5_spread'])
})

test('A preview reads OR15 structure without inventing an entry price', () => {
  const preview = buildPendingBuyExecutionPreviews([{
    symbol: '3311', kind: 'or15', status: 'defer', reason: 'or15_waiting_breakout',
    created_at: '2026-10-01 01:31:15',
    detail_json: JSON.stringify({ signal: { action: 'defer', reason: 'or15_waiting_breakout', orHigh: 52, orLow: 51, vwap: 51.33, latestBarMs: 1790818200000 }, bar_source: 'shioaji_research_current_session' }),
  }], 'or15_vwap_v1').get('3311')

  assert.equal(preview?.entry_owner, 'or15_vwap_v1')
  assert.equal(preview?.or15?.reason, 'or15_waiting_breakout')
  assert.equal(preview?.or15?.or_high, 52)
  assert.equal(preview?.or15?.vwap, 51.33)
  assert.equal(preview?.s12, null)
})

test('swing conditions preserve false/unknown and show price limits without inferring all-pass', () => {
  const preview=buildPendingBuyExecutionPreviews([{symbol:'2330',kind:'or15',status:'defer',reason:'swing_waiting_vwap',created_at:'2026-10-05 02:00:00',
    detail_json:JSON.stringify({signal:{action:'defer',conditions:{or_touch:true,vwap:false,position:null,invalid:'yes'},signalHigh:102,signalClose:99,maxBuyPrice:103,quotePrice:99}})}], 'or15-5m-orl8-20-v1').get('2330')
  assert.deepEqual(preview?.or15?.conditions,{or_touch:true,vwap:false,position:null,invalid:null})
  assert.equal(preview?.or15?.max_buy_price,103)
  assert.equal(preview?.or15?.signal_close,99)
})
