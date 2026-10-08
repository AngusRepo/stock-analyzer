import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checklistEvidence, checklistUnknownReason } from './pendingEntryChecklist'
test('latest window stays false; past quote never becomes a current green check',()=>{
 const old={checked_at:'2026-10-05 01:50:15',conditions:{plan:true,window:true,vwap:false,quote:true,chase:true}}
 const evidence=checklistEvidence({or15:{reason:'swing_next_bar_submission_missed',conditions:{window:false}},last_or15_assessment:old} as any)
 assert.equal(evidence.historical,true)
 assert.equal(evidence.conditions.window,false)
 assert.equal(evidence.conditions.plan,true)
 assert.equal(evidence.conditions.vwap,false)
 assert.equal(evidence.conditions.quote,null)
 assert.equal(evidence.conditions.chase,null)
 assert.equal(evidence.checkedAt,old.checked_at)
})
test('no history invents no pass; current rejection cannot borrow old evidence',()=>{
 assert.deepEqual(checklistEvidence(null).conditions,{})
 const evidence=checklistEvidence({or15:{reason:'swing_plan_not_authorized',conditions:{plan:false}},last_or15_assessment:{conditions:{plan:true,vwap:true}}} as any)
 assert.equal(evidence.historical,false)
 assert.equal(evidence.conditions.plan,false)
 assert.equal(evidence.conditions.vwap,undefined)
 assert.equal(checklistUnknownReason('final',true),'待送單時檢查')
})


test('confirmed prices and same-time returns display without fabricating missing old telemetry',async()=>{
 const {checklistNumbers}=await import('./pendingEntryChecklist')
 const s={signal_close:101,vwap:100.5,stock_return:.01,benchmark_return:0,relative_return:.01,
 quote_price:101,quote_observed_at_ms:1000,assessed_at_ms:3100} as any
 assert.match(checklistNumbers('vwap',s),/101.00.*100.50/)
 assert.match(checklistNumbers('relative_strength',s),/個股 \+1.00%.*0050 0.00%.*1.00 個百分點/)
 assert.match(checklistNumbers('quote',s),/2.1 秒/)
 assert.match(checklistNumbers('relative_strength',{relative_return:.01} as any),/個股 未記錄.*0050 未記錄/)
})
test('clock expiry clears execution checks while confirmed bar values remain',()=>{
 const s={latest_bar_ms:100000,conditions:{window:true,vwap:true,quote:true,chase:true,buy_limit:true}} as any
 const result=checklistEvidence({or15:s} as any,160000)
 assert.equal(result.conditions.window,false)
 assert.equal(result.conditions.quote,null)
 assert.equal(result.conditions.vwap,true)
})


test('daily ATR veto survives minute-only events while old quote green checks expire',()=>{
 const evidence=checklistEvidence({or15:{reason:'swing_atr_day_veto',conditions:{window:false,atr_once:false}},last_or15_assessment:{conditions:{plan:true,vwap:true,atr_once:false,quote:true}}} as any)
 assert.equal(evidence.conditions.atr_once,false);assert.equal(evidence.conditions.vwap,true);assert.equal(evidence.conditions.quote,null)
})

test('status-only legacy quote error keeps the last complete five-minute assessment',()=>{
 const last={checked_at:'2026-10-06 05:10:22',latest_bar_ms:100000,conditions:{plan:true,bars:true,or_touch:true,vwap:true,relative_strength:true,window:true,quote:false}}
 const current={reason:'or15_market_data_unavailable',checked_at:'2026-10-06 05:13:22'}
 const evidence=checklistEvidence({or15:current,last_or15_assessment:last} as any,160000)
 assert.equal(evidence.historical,true)
 assert.equal(evidence.checkedAt,last.checked_at)
 for(const key of ['plan','bars','or_touch','vwap','relative_strength']) assert.equal(evidence.conditions[key],true)
 assert.equal(evidence.conditions.window,false)
 assert.equal(evidence.conditions.quote,null)
})


test('normal waiting preserves a timestamped historical L5 blocker without granting execution checks',async()=>{
 const {lastEntryBlocker}=await import('./pendingEntryChecklist')
 const preview:any={or15:{reason:'swing_waiting_next_bar',conditions:{window:false}},
   last_blocker:{reason:'l4_hard_risk_veto',detail:'l5_status=blocked;l5_reasons=stale_l5_quote|wide_l5_spread',checked_at:'2026-10-08 02:15:23'}}
 assert.match(lastEntryBlocker(preview)??'',/10:15:23.*五檔時效未通過、買賣價差過大/)
 assert.match(lastEntryBlocker(preview)??'',/歷史紀錄/)
 assert.equal(checklistEvidence(preview).conditions.window,false)
 assert.equal(lastEntryBlocker(null),null)
})
