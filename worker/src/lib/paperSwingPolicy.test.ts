import assert from 'node:assert/strict'
import {assessSwingEntry,assessSwingExit,closeSwingSession,SWING_POLICY_VERSION,type SwingEntryInput,type SwingMinute} from './paperSwingPolicy'
const date='2026-10-02',open=Date.parse(date+'T09:00:00+08:00'),minute=60_000
const bars:SwingMinute[]=Array.from({length:20},(_,i)=>({startMs:open+i*minute,open:i<15?100:101,high:101,low:99,close:i<15?100:101,volume:100}))
const prior=Array.from({length:60},(_,i)=>({date:new Date(Date.UTC(2026,7,3+i)).toISOString().slice(0,10),close:i===59?100:98}))
const base:SwingEntryInput={tradeDate:date,nowMs:open+20*minute,label:'start',bars,benchmarkBars:bars.map(b=>({...b,open:100,high:100,low:100,close:100})),previousClose:100,benchmarkPreviousClose:100,benchmarkPriorCloses:prior,previousSession:'2026-10-01',quote:{price:101,observedAtMs:open+20*minute},limitUp:110,maxBuyPrice:103,boughtToday:false,alreadyHeld:false,planReady:true,candidateAllowed:true}
assert.equal(assessSwingEntry(base).action,'pass')
for(const elapsed of [245,250,255,260]) {
  const lateBars=Array.from({length:elapsed},(_,i)=>({...bars[Math.min(i,19)],startMs:open+i*minute}))
  const late={...base,nowMs:open+elapsed*minute,bars:lateBars,
    benchmarkBars:lateBars.map(b=>({...b,open:100,high:100,low:100,close:100})),
    quote:{price:101,observedAtMs:open+elapsed*minute}}
  assert.equal(assessSwingEntry(late).action,'pass',`late entry at ${elapsed} minutes`)
}
assert.equal(assessSwingEntry({...base,nowMs:open+261*minute}).reason,'swing_next_bar_submission_missed')
assert.equal(assessSwingEntry({...base,nowMs:open+265*minute}).reason,'swing_entry_window_closed')
assert.equal(assessSwingEntry({...base,nowMs:open+19*minute+59_999}).reason,'swing_entry_window_not_open')
assert.equal(assessSwingEntry({...base,nowMs:open+21*minute}).reason,'swing_next_bar_submission_missed')
assert.equal(assessSwingEntry({...base,bars:bars.slice(1)}).reason,'swing_minutes_missing')
assert.equal(assessSwingEntry({...base,label:'end',bars:bars.map(b=>({...b,startMs:b.startMs+minute})),benchmarkBars:base.benchmarkBars.map(b=>({...b,startMs:b.startMs+minute}))}).action,'pass')
assert.equal(assessSwingEntry({...base,benchmarkPreviousClose:98}).reason,'swing_ma60_evidence_missing')
assert.equal(assessSwingEntry({...base,benchmarkPriorCloses:prior.map(x=>({...x,close:100}))}).reason,'swing_market_below_ma60')
assert.equal(assessSwingEntry({...base,benchmarkBars:base.benchmarkBars.slice(0,-1)}).reason,'swing_benchmark_timestamp_missing')
assert.equal(assessSwingEntry({...base,limitUp:101}).reason,'swing_opening_range_at_limit')
assert.equal(assessSwingEntry({...base,quote:{price:110,observedAtMs:base.nowMs}}).reason,'swing_buy_at_limit')
assert.equal(assessSwingEntry({...base,maxBuyPrice:100}).reason,'swing_chase_limit')
assert.equal(assessSwingEntry({...base,boughtToday:true}).reason,'swing_existing_position_or_daily_fill')
assert.equal(assessSwingEntry({...base,quote:{price:101,observedAtMs:base.nowMs+1}}).reason,'swing_fresh_execution_quote_missing')
const missingExecutableQuote=assessSwingEntry({...base,quote:{price:Number.NaN,observedAtMs:Number.NaN}})
assert.equal(missingExecutableQuote.reason,'swing_fresh_execution_quote_missing')
assert.equal(missingExecutableQuote.action,'defer')
assert.equal(missingExecutableQuote.conditions?.ma60,true)
assert.equal(missingExecutableQuote.conditions?.opening_limit,true)
assert.equal(missingExecutableQuote.conditions?.quote,false)
const same=assessSwingEntry({...base,bars:[...bars,{...bars[19],startMs:base.nowMs,close:109,high:109}]})
assert.deepEqual(same,assessSwingEntry(base),'unclosed next bar cannot change signal')
const calendar=Array.from({length:40},(_,i)=>new Date(Date.UTC(2026,9,2+i))).filter(d=>![0,6].includes(d.getUTCDay())).map(d=>d.toISOString().slice(0,10)).filter(d=>d!=='2026-10-09').slice(0,22) // synthetic exchange calendar includes an explicit closure
const state={policy:SWING_POLICY_VERSION,entryDate:date,entryPrice:100,entryOrLow:99}
assert.equal(assessSwingExit(state,{date,nowMs:base.nowMs,price:92,calendar:[]}).reason,'swing_hard_stop_8')
assert.equal(assessSwingExit(state,{date,nowMs:base.nowMs,price:150,calendar}).action,'hold','no implicit TP')
const pending=closeSwingSession(state,{date,close:98,observedAtMs:Date.parse(date+'T13:30:00+08:00'),nextSession:calendar[1],calendar})
const due=Date.parse(calendar[1]+'T09:05:00+08:00')
assert.equal(assessSwingExit(pending,{date:calendar[1],nowMs:due-1,price:105,calendar}).action,'hold')
assert.equal(assessSwingExit(pending,{date:calendar[1],nowMs:due,price:105,calendar}).reason,'swing_daily_orl','rebound does not cancel queued exit')
assert.equal(assessSwingExit(pending,{date:calendar[2],nowMs:due+86400000,price:95,calendar}).action,'full_sell','unfilled intent persists')
const twentieth=calendar[20],closeTime=Date.parse(twentieth+'T13:24:00+08:00')
assert.equal(assessSwingExit(state,{date:twentieth,nowMs:closeTime-1,price:103,calendar}).action,'hold')
assert.equal(assessSwingExit(state,{date:twentieth,nowMs:closeTime,price:103,calendar}).reason,'swing_20_sessions')
assert.throws(()=>closeSwingSession(state,{date,close:98,observedAtMs:base.nowMs,nextSession:calendar[1],calendar}),/not_final/)
console.log('paperSwingPolicy: entry timing, freshness, filters, no-TP, queued ORL and session expiry passed')

assert.equal(assessSwingEntry({...base,bars:bars.map(b=>({...b,amount:b.close*b.volume*1000}))}).reason,'swing_turnover_volume_units_invalid')
assert.throws(()=>closeSwingSession(state,{date,close:98,observedAtMs:NaN,nextSession:calendar[1],calendar}),/not_final/)
assert.equal(calendar[1],'2026-10-05','weekend is excluded from age')
assert.ok(Date.parse(calendar[20])-Date.parse(date)>20*86400000,'20 trading sessions exceeds 20 calendar days')

const expiry={...state,pendingExit:{reason:'swing_20_sessions' as const,notBeforeMs:closeTime}}
for(const clock of ['13:25','13:30']) assert.equal(assessSwingExit(expiry,{date:twentieth,nowMs:Date.parse(twentieth+'T'+clock+':00+08:00'),price:103,calendar:[]}).action,'hold')
assert.equal(assessSwingExit(expiry,{date:calendar[21],nowMs:Date.parse(calendar[21]+'T09:04:00+08:00'),price:103,calendar:[]}).action,'hold')
assert.equal(assessSwingExit(expiry,{date:calendar[21],nowMs:Date.parse(calendar[21]+'T09:05:00+08:00'),price:103,calendar:[]}).reason,'swing_20_sessions')
assert.equal(assessSwingExit(state,{date:calendar[21],nowMs:Date.parse(calendar[21]+'T09:05:00+08:00'),price:103,calendar}).reason,'swing_20_sessions','missed expiry poll catches up next session')

// First-minute touch is not sufficient: the completed fifth-minute close controls VWAP.
const reverted=bars.map((b,i)=>i===19?{...b,low:98,close:98}:b)
const rejected=assessSwingEntry({...base,bars:reverted})
assert.equal(rejected.reason,'swing_waiting_vwap')
assert.equal(rejected.conditions?.or_touch,true)
assert.equal(rejected.conditions?.vwap,false)
assert.equal(rejected.conditions?.relative_strength,false,'show all evaluated criteria, not just first failure')
assert.equal(assessSwingEntry({...base,planReady:false}).conditions?.vwap,null,'no invented pass without evidence')
assert.equal(assessSwingEntry({...base,quote:{price:99,observedAtMs:base.nowMs}}).action,'pass','no extra submission VWAP filter after completed signal')
assert.equal(assessSwingEntry({...base,quote:{price:104,observedAtMs:base.nowMs}}).conditions?.chase,false)
assert.equal(assessSwingEntry({...base,quote:{price:101,observedAtMs:base.nowMs-1}}).conditions?.quote,false,'pre-signal quote cannot execute')


const diagnostic=assessSwingEntry(base)
assert.equal(diagnostic.stockReturn,.010000000000000009)
assert.equal(diagnostic.benchmarkReturn,0)
assert.equal(diagnostic.stockReturn!-diagnostic.benchmarkReturn!,diagnostic.relativeReturn)
assert.equal(diagnostic.benchmarkClose,100)
assert.equal(diagnostic.benchmarkPreviousClose,100)
assert.equal(diagnostic.quoteObservedAtMs,base.quote.observedAtMs)
assert.equal(diagnostic.assessedAtMs,base.nowMs)
assert.equal(diagnostic.limitUp,110)
