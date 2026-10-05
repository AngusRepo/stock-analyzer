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
