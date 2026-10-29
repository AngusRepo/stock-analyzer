import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { secondMomentumPasses, assessSecondBreakout, authorizeSecondBreakout, recoverSecondBreakout, recoveryDeadline, secondBreakoutEnabled, SECOND_BREAKOUT_POLICY } from './paperSecondBreakout'
import { readSecondBreakout, latchSecondBreakout, authorizeLatchedSecondBreakout, secondBreakoutLateAuthorizationOpen } from './paperSecondBreakoutState'
import { previousAtrTR, applyAtrOnce } from './paperAtrOnce'
import { assessSwingEntry, type SwingEntryInput } from './paperSwingPolicy'
import { swingExecutionAuthorization, swingExecutionRejection } from './paperSwingExecution'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import fixtures from './paperSecondBreakout.cases.fixture.json'
const MIN=60_000, date='2026-10-15',open=Date.parse(date+'T09:00:00+08:00')
function input(values:number[]):SwingEntryInput {
  const bars=values.flatMap((close,n)=>Array.from({length:5},(_,i)=>({startMs:open+(n*5+i)*MIN,open:close,high:close,low:close,close,volume:100})))
  return {tradeDate:date,nowMs:open+values.length*5*MIN,label:'start',bars,benchmarkBars:bars.map(b=>({...b,open:100,high:100,low:100,close:100})),
    previousClose:100,benchmarkPreviousClose:100,previousSession:'2026-10-14',benchmarkPriorCloses:Array.from({length:60},(_,i)=>({date:new Date(Date.UTC(2026,7,16+i)).toISOString().slice(0,10),close:i===59?100:98})),
    quote:{price:101,observedAtMs:open+values.length*5*MIN},limitUp:110,maxBuyPrice:103,boughtToday:false,alreadyHeld:false,planReady:true,candidateAllowed:true}
}
function actual(symbol:keyof typeof fixtures,clock:string):SwingEntryInput {
 const f=fixtures[symbol]
 return {...input([]),...f,nowMs:Date.parse(f.tradeDate+'T'+clock+':00+08:00'),limitUp:f.previousClose*1.1,maxBuyPrice:f.previousClose*1.1}
}
test('first strong remains unchanged; first weak waits and later S uses recomputed ATR',()=>{
 const strong=input([100,100,100,101]);const r=assessSecondBreakout(strong,0)
 assert.equal(r.triggerKind,'first');assert.equal(r.triggerMs,open+20*MIN)
 assert.equal(assessSecondBreakout(input([100,100,100,100]),0).status,'weak_waiting')
 const s=assessSecondBreakout(input([100,100,100,100,102,104]),0)
 assert.equal(s.triggerKind,'second');assert.equal(s.triggerMs,open+25*MIN)
 assert.equal(s.atr5,.4);assert.equal(s.delta,2);assert.equal(s.priorHigh,100)
 assert.equal(s.signals.at(-1)?.legacyWouldBuy,false)
})
test('all intervening HIGHs count, current/future highs excluded, no equality or tick buffer',()=>{
 const x=input([100,100,100,100,99,103,104]);x.bars[20].high=103
 x.bars[30].high=105
 const r=assessSecondBreakout(x,0)
 const equality=r.signals.find(s=>s.signalMs===open+30*MIN)!
 assert.equal(equality.rWouldTrigger,true);assert.equal(equality.priorHigh,103);assert.equal(equality.newHigh,false)
 assert.equal(r.triggerMs,open+35*MIN);assert.equal(r.priorHigh,103)
 assert.equal(assessSecondBreakout({...x,bars:[...x.bars,{...x.bars[0],startMs:open+35*MIN,high:999}]},0).triggerMs,r.triggerMs)
})
test('missing evidence fails closed and first warmup cannot shift first signal',()=>{
 const x=input([100,100,100,100,102])
 assert.equal(assessSecondBreakout(x).reason,'swing_atr_warmup_missing')
 x.benchmarkBars=x.benchmarkBars.filter(b=>b.startMs!==open+19*MIN)
 assert.equal(assessSecondBreakout(x,0).status,'unknown')
})
test('start/end labels agree and execution price guards remain independent',()=>{
 const x=input([100,100,100,100,102]);x.quote.price=109
 const r=assessSecondBreakout(x,0)
 assert.deepEqual(assessSecondBreakout({...x,label:'end',bars:x.bars.map(b=>({...b,startMs:b.startMs+MIN})),benchmarkBars:x.benchmarkBars.map(b=>({...b,startMs:b.startMs+MIN}))},0),r)
 assert.equal(applyAtrOnce(assessSwingEntry(x),r).action,'defer')
 const saved=authorizeSecondBreakout(x,r)
 const next={nowMs:x.nowMs+MIN,price:109,observedAtMs:x.nowMs+MIN,planReady:true,candidateAllowed:true}
 assert.equal(recoverSecondBreakout(saved,next)?.reason,'swing_chase_limit')
 assert.equal(recoverSecondBreakout(saved,{...next,price:110})?.reason,'swing_buy_at_limit')
 assert.equal(recoverSecondBreakout(saved,{...next,price:101,observedAtMs:x.nowMs-1})?.reason,'swing_fresh_execution_quote_missing')
 assert.equal(recoverSecondBreakout(saved,{...next,price:101,planReady:false})?.reason,'swing_plan_not_authorized')
})
test('shared recovery keeps signal/ceiling; expired, stale and unobserved signals cannot buy',()=>{
 for(const values of [[100,100,100,101],[100,100,100,100,102]]) {
  const x=input(values),r=authorizeSecondBreakout(x,assessSecondBreakout(x,0))
  const now=x.nowMs+29*MIN,decision=recoverSecondBreakout(r,{nowMs:now,price:101,observedAtMs:now,planReady:true,candidateAllowed:true})!
  assert.equal(decision.action,'pass');assert.equal(decision.signalMs,x.nowMs)
  const auth=swingExecutionAuthorization(decision)!
  assert.ok(auth);assert.equal(auth.maxBuyPrice,103)
  assert.equal(swingExecutionRejection(auth,{nowMs:now,fillPrice:104,limitPrice:103,limitUp:110}),'swing_chase_limit')
  assert.equal(recoverSecondBreakout(r,{nowMs:x.nowMs+30*MIN,price:101,observedAtMs:x.nowMs+30*MIN,planReady:true,candidateAllowed:true})?.reason,'swing_recovery_expired')
  // R14: a first observation after the trigger minute still authorizes, but only before the original deadline.
  const late=authorizeSecondBreakout({...x,nowMs:x.nowMs+MIN},assessSecondBreakout(x,0)).authorization
  assert.ok(late);assert.equal(late.submitUntilMs,x.nowMs+30*MIN);assert.equal(late.signalMs,x.nowMs)
  assert.equal(authorizeSecondBreakout({...x,nowMs:x.nowMs+30*MIN},assessSecondBreakout(x,0)).authorization,undefined)
  assert.equal(authorizeSecondBreakout({...x,nowMs:x.nowMs-1},assessSecondBreakout(x,0)).authorization,undefined)
 }
 assert.equal(recoveryDeadline(date,open+260*MIN),open+261*MIN)
 assert.equal(secondBreakoutEnabled('2026-10-14'),false);assert.equal(secondBreakoutEnabled(date),true)
})
test('durable weak -> passed is atomic, monotonic, restart-safe and account/date isolated',async()=>{
 const f=l4NativeFixture();try {
  const db=f.env.PAPER_DB,weak=assessSecondBreakout(input([100,100,100,100]),0),x=input([100,100,100,100,102])
  await latchSecondBreakout(db,1,date,'X',weak)
  const passed=authorizeSecondBreakout(x,assessSecondBreakout(x,0))
  await Promise.all([latchSecondBreakout(db,1,date,'X',passed),latchSecondBreakout(db,1,date,'X',weak)])
  const restored=await readSecondBreakout(db,1,date,'X')
  assert.equal(restored?.status,'passed');assert.deepEqual(restored?.authorization,passed.authorization)
  await latchSecondBreakout(db,1,date,'X',passed)
  assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_second_breakout_signals_v2').get()?.n,2)
  assert.equal(await readSecondBreakout(db,2,date,'X'),null);assert.equal(await readSecondBreakout(db,1,'2026-10-16','X'),null)
  await assert.rejects(latchSecondBreakout(db,1,date,'X',{...passed,firstSignalMs:open+25*MIN}),/first_signal_conflict/)
 } finally {f.close()}
})
test('4991 actual bars: first 09:35 weak; 10:35 strong and 490 > 489',()=>{
 const r=assessSecondBreakout(actual('4991','10:40'))
 assert.equal(r.firstSignalMs,Date.parse('2026-10-14T09:40:00+08:00'))
 assert.equal(r.firstDelta,2.5);assert.equal(r.firstThreshold,6)
 assert.equal(r.triggerMs,Date.parse('2026-10-14T10:40:00+08:00'))
 assert.equal(r.close,490);assert.equal(r.priorHigh,489);assert.equal(r.delta,5);assert.ok(Math.abs(r.threshold!-3.9)<1e-10)
})
test('2337 actual bars: 09:20 equality is R only, 09:25 strict new high is S',()=>{
 const f=fixtures['2337'],tr=previousAtrTR(f.priorBars,f.previousSession,f.previousClose,f.previousClose)
 assert.ok(tr!=null)
 const r=assessSecondBreakout(actual('2337','09:30'),tr)
 assert.equal(r.firstSignalMs,Date.parse('2026-10-14T09:20:00+08:00'))
 assert.equal(r.signals[0].rWouldTrigger,false)
 const equality=r.signals.find(s=>s.signalMs===Date.parse('2026-10-14T09:25:00+08:00'))!
 assert.equal(equality.close,108);assert.equal(equality.priorHigh,108);assert.equal(equality.rWouldTrigger,true);assert.equal(equality.sWouldTrigger,false)
 assert.equal(r.triggerMs,Date.parse('2026-10-14T09:30:00+08:00'));assert.equal(r.close,108.5);assert.equal(r.priorHigh,108)
})
test('6994 complete saved day: .55 <= .585 and no later qualified signal',()=>{
 const r=assessSecondBreakout(actual('6994','13:20'))
 assert.equal(r.status,'weak_waiting');assert.equal(r.triggerMs,undefined);assert.equal(r.signals.length,1)
 assert.ok(Math.abs(r.firstDelta!-.55)<1e-10);assert.ok(Math.abs(r.firstThreshold!-.585)<1e-10)
})


test('momentum equality and epsilon boundary remain strict, no threshold search',()=>{
 assert.equal(secondMomentumPasses(1.5+1e-10,1),false)
 assert.equal(secondMomentumPasses(1.5+2e-10,1),true)
 assert.equal(secondMomentumPasses(NaN,1),false)
})

test('R14 replay: 4991 and 2337 first observed late are authorized until the original deadline; 6994 never',()=>{
 for(const [symbol,trigger,clock,deadline] of [['4991','10:40','10:41','11:10'],['2337','09:30','09:31','10:00']] as const) {
  const evidence=assessSecondBreakout(actual(symbol,clock),symbol==='2337'?previousAtrTR(fixtures['2337'].priorBars,fixtures['2337'].previousSession,fixtures['2337'].previousClose,fixtures['2337'].previousClose)!:undefined)
  const triggerMs=Date.parse(`2026-10-14T${trigger}:00+08:00`),deadlineMs=Date.parse(`2026-10-14T${deadline}:00+08:00`)
  assert.equal(evidence.triggerMs,triggerMs)
  // Observed 5 minutes after the trigger (e.g. the trigger-bar minute was missed): still authorized.
  const late=authorizeSecondBreakout({...actual(symbol,clock),nowMs:triggerMs+5*MIN},evidence).authorization
  assert.ok(late,symbol);assert.equal(late.submitUntilMs,deadlineMs);assert.equal(late.signalMs,triggerMs)
  // The same price checks still run on recovery.
  const quote={nowMs:triggerMs+6*MIN,observedAtMs:triggerMs+6*MIN,planReady:true,candidateAllowed:true}
  assert.equal(recoverSecondBreakout({...evidence,authorization:late},{...quote,price:late.limitUp!})?.reason,'swing_buy_at_limit')
  assert.equal(authorizeSecondBreakout({...actual(symbol,clock),nowMs:deadlineMs},evidence).authorization,undefined)
 }
 const r=assessSecondBreakout(actual('6994','13:20'))
 assert.equal(authorizeSecondBreakout(actual('6994','13:20'),r).authorization,undefined)
})
test('R14: a passed signal latched without authorization (plan arrived late) is authorized once, never replaced',async()=>{
 const f=l4NativeFixture();try {
  const db=f.env.PAPER_DB,x=input([100,100,100,101])
  const unauthorized=authorizeSecondBreakout({...x,planReady:false},assessSecondBreakout(x,0))
  assert.equal(unauthorized.authorization,undefined)
  const latched=await latchSecondBreakout(db,1,date,'X',unauthorized)
  assert.equal(latched.status,'passed');assert.equal(latched.authorization,undefined)
  const later={...x,nowMs:x.nowMs+7*MIN}
  const first=authorizeSecondBreakout(later,latched)
  const second=authorizeSecondBreakout({...later,nowMs:later.nowMs+MIN},latched)
  await Promise.all([authorizeLatchedSecondBreakout(db,1,date,'X',first,later.nowMs),authorizeLatchedSecondBreakout(db,1,date,'X',second,later.nowMs+MIN)])
  const saved=await readSecondBreakout(db,1,date,'X')
  assert.ok(saved?.authorization);assert.equal(saved!.authorization!.submitUntilMs,x.nowMs+30*MIN)
  assert.ok([first,second].some(v=>JSON.stringify(v.authorization)===JSON.stringify(saved!.authorization)))
  // An existing authorization is never replaced, and a different trigger cannot write.
  const before=JSON.stringify(saved!.authorization)
  await authorizeLatchedSecondBreakout(db,1,date,'X',{...second,authorization:{...second.authorization!,submitUntilMs:1}},later.nowMs+2*MIN)
  assert.equal(JSON.stringify((await readSecondBreakout(db,1,date,'X'))!.authorization),before)
  await assert.rejects(authorizeLatchedSecondBreakout(db,1,date,'X',{...first,triggerMs:x.nowMs+5*MIN},later.nowMs),/first_signal_conflict/)
  // Other accounts/dates are untouched.
  assert.equal(await readSecondBreakout(db,2,date,'X'),null)
  // Past the deadline nothing new is authorized.
  assert.equal(authorizeSecondBreakout({...x,nowMs:x.nowMs+30*MIN},unauthorized).authorization,undefined)
  // The UPDATE itself refuses a write at or after the original deadline, even with an authorization in hand.
  const other=await latchSecondBreakout(db,1,date,'Y',unauthorized)
  const deadline=recoveryDeadline(date,other.triggerMs!)
  const stale=await authorizeLatchedSecondBreakout(db,1,date,'Y',authorizeSecondBreakout(later,other),deadline)
  assert.equal(stale.authorization,undefined)
  assert.ok((await authorizeLatchedSecondBreakout(db,1,date,'Y',authorizeSecondBreakout(later,other),deadline-1)).authorization)
 } finally {f.close()}
})
test('R14 wiring: the swing assessor re-evaluates an unauthorized passed signal off the bar minute until its deadline',()=>{
 const triggerMs=open+20*MIN
 const saved={...assessSecondBreakout(input([100,100,100,101]),0),triggerMs}
 assert.equal(saved.status,'passed');assert.equal(saved.authorization,undefined)
 // Open from the trigger until the original deadline (exclusive), whatever the bar minute.
 assert.equal(secondBreakoutLateAuthorizationOpen(saved,date,triggerMs+7*MIN+30_000),true)
 assert.equal(secondBreakoutLateAuthorizationOpen(saved,date,recoveryDeadline(date,triggerMs)-1),true)
 assert.equal(secondBreakoutLateAuthorizationOpen(saved,date,recoveryDeadline(date,triggerMs)),false)
 // Already authorized, not passed, no trigger, or nothing saved: the old saved-signal path.
 assert.equal(secondBreakoutLateAuthorizationOpen({...saved,authorization:{} as any},date,triggerMs+MIN),false)
 assert.equal(secondBreakoutLateAuthorizationOpen({...saved,status:'weak_waiting'},date,triggerMs+MIN),false)
 assert.equal(secondBreakoutLateAuthorizationOpen({...saved,triggerMs:undefined},date,triggerMs+MIN),false)
 assert.equal(secondBreakoutLateAuthorizationOpen(null,date,triggerMs+MIN),false)
 const src=readFileSync('src/lib/paperSwingAssessment.ts','utf8')
 const late=src.indexOf('const lateAuthorization=secondBreakoutLateAuthorizationOpen(savedSecond,today,paperExecutionNow())')
 assert.ok(late>0)
 // It skips the saved-signal shortcut and the bar-minute gate, then authorizes the latched row once.
 assert.ok(src.indexOf("if(savedSecond?.status==='passed' && !lateAuthorization)")>late)
 assert.ok(src.indexOf('if(!lateAuthorization && (sinceOpen<20*60000')>late)
 const write=src.indexOf('atr=await authorizeLatchedSecondBreakout(db,account,today,pending.symbol,authorizeSecondBreakout(swingInput,atr),swingInput.nowMs)')
 assert.ok(write>src.indexOf('let atr=useSecond?savedSecond:'))
 assert.ok(src.slice(write-120,write).includes('if(lateAuthorization && atr?.policy===SECOND_BREAKOUT_POLICY)'))
 assert.ok(write<src.indexOf('assessment=recoverSecondBreakout(atr as SecondBreakoutEvidence'),'recovery still re-checks price after authorization')
})
