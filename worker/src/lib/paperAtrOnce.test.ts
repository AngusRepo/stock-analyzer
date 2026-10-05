import assert from 'node:assert/strict'
import test from 'node:test'
import {assessAtrOnce,applyAtrOnce,previousAtrTR} from './paperAtrOnce'
import {assessSwingEntry,type SwingEntryInput} from './paperSwingPolicy'
import {latchAtrOnce,readAtrOnce} from './paperAtrOnceState'
import {l4NativeFixture} from './l4NativeFixture.testSupport'
const date='2026-10-02',open=Date.parse(date+'T09:00:00+08:00'),MIN=60000
const prior=Array.from({length:60},(_,i)=>({date:new Date(Date.UTC(2026,7,3+i)).toISOString().slice(0,10),close:i===59?100:98}))
function input(values:number[]):SwingEntryInput {
 const bars=values.flatMap((close,n)=>Array.from({length:5},(_,i)=>({startMs:open+(n*5+i)*MIN,open:close,high:close,low:close,close,volume:100})))
 return {tradeDate:date,nowMs:open+values.length*5*MIN,label:'start',bars,benchmarkBars:bars.map(b=>({...b,open:100,high:100,low:100,close:100})),previousClose:100,benchmarkPreviousClose:100,benchmarkPriorCloses:prior,previousSession:'2026-10-01',quote:{price:101,observedAtMs:open+values.length*5*MIN},limitUp:110,maxBuyPrice:103,boughtToday:false,alreadyHeld:false,planReady:true,candidateAllowed:true}
}
test('first fail remains veto even later momentum passes',()=>{
 const first=assessAtrOnce(input([100,100,100,100]),0)
 assert.equal(first.status,'veto');assert.deepEqual(assessAtrOnce(input([100,100,100,100,102,104]),0),first)
 assert.equal(applyAtrOnce(assessSwingEntry(input([100,100,100,100,102])),first).action,'defer')
})
test('09:20 unknown can repair previous TR; unclosed minute ignored',()=>{
 const x=input([100,100,100,101]);assert.equal(assessAtrOnce(x).status,'unknown')
 assert.equal(assessAtrOnce(x).firstSignalMs,open+20*MIN);assert.equal(assessAtrOnce(x,0).status,'passed')
 assert.equal(assessAtrOnce({...x,bars:[...x.bars,{...x.bars[0],startMs:open+20*MIN,close:500,high:500}]}).status,'unknown')
})
test('first signal at 09:25 needs no previous warmup',()=>{
 const r=assessAtrOnce(input([100,100,100,99,101]))
 assert.equal(r.firstSignalMs,open+25*MIN);assert.equal(r.status,'passed');assert.equal(r.atr5,.6)
})
test('missing historical benchmark never selects later first',()=>{
 const x=input([100,100,100,100,102]);x.benchmarkBars=x.benchmarkBars.filter(b=>b.startMs!==open+19*MIN)
 assert.equal(assessAtrOnce(x,0).reason,'swing_atr_first_signal_evidence_missing')
})
test('start/end timestamps agree; synthetic quote never authorizes execution',()=>{
 const x=input([100,100,100,101]);x.quote.observedAtMs=open
 const r=assessAtrOnce(x,0);assert.equal(r.status,'passed');assert.equal(applyAtrOnce(assessSwingEntry(x),r).action,'defer')
 assert.deepEqual(r,assessAtrOnce({...x,label:'end',bars:x.bars.map(b=>({...b,startMs:b.startMs+MIN})),benchmarkBars:x.benchmarkBars.map(b=>({...b,startMs:b.startMs+MIN}))},0))
})
test('previous TR excludes auction and adjusts reference basis',()=>{
 const end=Date.parse('2026-10-01T13:25:00+08:00')
 const bars=Array.from({length:6},(_,i)=>({startMs:end-(6-i)*MIN,open:100,high:102,low:99,close:100,volume:1}))
 bars.push({...bars[0],startMs:end,high:200});assert.equal(previousAtrTR(bars,'2026-10-01',100,50),1.5)
 assert.equal(previousAtrTR(bars.slice(1),'2026-10-01',100,50),undefined)
})
test('durable veto survives restart and concurrent contenders, isolates dates/accounts',async()=>{
 const f=l4NativeFixture();try{
 const db=f.env.PAPER_DB,r=assessAtrOnce(input([100,100,100,100]),0)
 await latchAtrOnce(db,1,date,'6994',r)
 await Promise.all([latchAtrOnce(db,1,date,'6994',{...r,status:'passed'}),latchAtrOnce(db,1,date,'6994',r)])
 assert.equal((await readAtrOnce(db,1,date,'6994'))?.status,'veto')
 assert.equal(await readAtrOnce(db,2,date,'6994'),null);assert.equal(await readAtrOnce(db,1,'2026-10-05','6994'),null)
 }finally{f.close()}
})
test('unknown repairs same timestamp only',async()=>{
 const f=l4NativeFixture();try{
 const db=f.env.PAPER_DB,r=assessAtrOnce(input([100,100,100,101]))
 await latchAtrOnce(db,1,date,'6994',r)
 await assert.rejects(latchAtrOnce(db,1,date,'6994',{...r,firstSignalMs:r.firstSignalMs!+300000,status:'passed'}),/first_signal_conflict/)
 assert.equal((await latchAtrOnce(db,1,date,'6994',assessAtrOnce(input([100,100,100,101]),0))).status,'passed')
 }finally{f.close()}
})

import fixture from './paperAtrOnce.6994.fixture.json'
test('actual 6994 09:50 first signal matches Python research .55 vs .585, day veto',()=>{
 const toBars=(rows:typeof fixture.stock)=>rows.map(b=>({...b,startMs:Date.parse(b.ts)}))
 const x=input([100,100,100,100])
 const r=assessAtrOnce({...x,tradeDate:'2026-10-05',previousSession:'2026-10-02',nowMs:Date.parse('2026-10-05T10:00:00+08:00'),label:'end',
   bars:toBars(fixture.stock),benchmarkBars:toBars(fixture.benchmark),previousClose:fixture.reference,benchmarkPreviousClose:fixture.benchmarkReference,
   // This fixture isolates intraday math. MA60 authorization is covered separately by the existing policy tests.
   benchmarkPriorCloses:prior.map((p,i)=>({...p,date:i===59?'2026-10-02':p.date,close:i===59?fixture.benchmarkReference:fixture.benchmarkReference-1})),
   limitUp:35.25,maxBuyPrice:33.4})
 assert.equal(r.status,'veto');assert.equal(r.firstSignalMs,Date.parse('2026-10-05T09:50:00+08:00'))
 assert.ok(Math.abs(r.delta!-.55)<1e-10);assert.ok(Math.abs(r.atr5!-.39)<1e-10);assert.ok(Math.abs(r.threshold!-.585)<1e-10)
})
