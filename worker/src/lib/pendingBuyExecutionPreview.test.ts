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


test('timing-only minute keeps last assessment separate from current execution status', () => {
 const p=buildPendingBuyExecutionPreviews([
  {symbol:'6217',kind:'or15',status:'defer',reason:'swing_waiting_vwap',created_at:'2026-10-05 01:50:15',detail_json:JSON.stringify({signal:{conditions:{plan:true,window:true,vwap:false},vwap:100}})},
  {symbol:'6217',kind:'or15',status:'defer',reason:'swing_next_bar_submission_missed',created_at:'2026-10-05 01:51:15',detail_json:JSON.stringify({signal:{conditions:{window:false}}})},
 ],'or15-5m-orl8-20-v1').get('6217')
 assert.equal(p?.or15?.reason,'swing_next_bar_submission_missed')
 assert.deepEqual(p?.or15?.conditions,{window:false})
 assert.equal(p?.last_or15_assessment?.conditions?.vwap,false)
 assert.equal(p?.last_or15_assessment?.checked_at,'2026-10-05 01:50:15')
})


test('daily evidence and raw comparison inputs survive a later timing-only audit',()=>{
 const rows=[{symbol:'2330',kind:'or15' as const,status:'pass',reason:'swing_or15_vwap_relative_strength',created_at:'2026-10-05 01:20:10',
 detail_json:JSON.stringify({signal:{conditions:{plan:true,ma60:true,opening_limit:true},stockReturn:0,benchmarkReturn:-.01,benchmarkClose:99,benchmarkPreviousClose:100,quoteObservedAtMs:1791163200000,assessedAtMs:1791163210000,limitUp:110}})},
 {symbol:'2330',kind:'or15' as const,status:'defer',reason:'swing_next_bar_submission_missed',created_at:'2026-10-05 02:01:10',detail_json:JSON.stringify({signal:{conditions:{window:false}}})}]
 const result=buildPendingBuyExecutionPreviews(rows,'or15-5m-orl8-20-v1').get('2330')!
 assert.equal(result.daily_assessment?.conditions?.ma60,true)
 assert.equal(result.daily_assessment?.stock_return,0)
 assert.equal(result.daily_assessment?.benchmark_return,-.01)
 assert.equal(result.daily_assessment?.quote_observed_at_ms,1791163200000)
 assert.equal(result.or15?.conditions?.window,false)
})

test('missing broker book still advances the daily baseline without authorizing entry',()=>{
 const rows=[
  {symbol:'3004',kind:'or15' as const,status:'error',reason:'or15_market_data_unavailable',created_at:'2026-10-06 04:15:11',detail_json:JSON.stringify({stage:'authoritative_market_data'})},
  {symbol:'3004',kind:'or15' as const,status:'defer',reason:'swing_fresh_execution_quote_missing',created_at:'2026-10-06 04:15:17',
   detail_json:JSON.stringify({signal:{action:'defer',reason:'swing_fresh_execution_quote_missing',conditions:{plan:true,ma60:true,opening_limit:true,quote:false},quotePrice:null}})},
 ]
 const result=buildPendingBuyExecutionPreviews(rows,'or15-5m-orl8-20-v1').get('3004')!
 assert.equal(result.daily_assessment?.checked_at,'2026-10-06 04:15:17')
 assert.equal(result.daily_assessment?.conditions?.quote,false)
 assert.equal(result.or15?.action,'defer')
 assert.equal(result.or15?.quote_price,null)
})


test('D1 readback retains the actual blocker beyond five minutes alongside current waiting status',async()=>{
 const {l4NativeFixture}=await import('./l4NativeFixture.testSupport')
 const {withPaperExecutionScope}=await import('./paperExecutionScope')
 const {loadPendingBuyExecutionPreviews}=await import('./pendingBuyExecutionPreview')
 const f=l4NativeFixture()
 try {
   f.ports.nowMs=Date.parse('2026-09-14T01:26:00Z')
   f.env.PAPER_INTRADAY_ENTRY_OWNER='or15-5m-orl8-20-v1'
   const insert=f.sqls.paper.prepare(`INSERT INTO paper_execution_events
     (account_id,trade_date,symbol,event_type,status,reason,detail_json,source,created_at) VALUES(1,'2026-09-14','3004',?,?,?,?,?,?)`)
   insert.run('pending_buy','allocator_skip','l4_hard_risk_veto',JSON.stringify({detail:'l5_status=blocked;l5_reasons=stale_l5_quote'}),'intraday_check','2026-09-14 01:15:23')
   insert.run('intraday_technical_decision','defer','swing_waiting_next_bar',JSON.stringify({signal:{conditions:{window:false}}}),'or15-5m-orl8-20-v1','2026-09-14 01:26:00')
   const {result}=await withPaperExecutionScope(f.ports,()=>loadPendingBuyExecutionPreviews(f.env,'2026-09-14',['3004']))
   assert.equal(result.get('3004')?.last_blocker?.reason,'l4_hard_risk_veto')
   assert.match(result.get('3004')?.last_blocker?.detail??'',/stale_l5_quote/)
   assert.equal(result.get('3004')?.or15?.reason,'swing_waiting_next_bar')
   assert.equal(result.get('3004')?.allocator,null,'old allocation must not become current authorization')
 } finally {f.close()}
})
