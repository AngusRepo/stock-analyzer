import { assessAtrOnce, type AtrOnceEvidence } from './paperAtrOnce'
import { assessSwingEntry, type SwingEntryInput, type SwingEntryDecision } from './paperSwingPolicy'

export const SECOND_BREAKOUT_POLICY = 'atr5-sma-second-breakout-s-v2' as const
export const SECOND_BREAKOUT_EFFECTIVE_DATE = '2026-10-15'
const MIN = 60_000
export const secondMomentumPasses = (delta:number, atr5:number) => delta > 1.5*atr5 + 1e-10
export type SecondBreakoutSignal = {
  signalMs: number; close: number; delta: number; atr5: number; threshold: number;
  priorHigh: number | null; newHigh: boolean; rWouldTrigger: boolean; sWouldTrigger: boolean;
  legacyWouldBuy: boolean;
}
export type SecondBreakoutEvidence = Omit<AtrOnceEvidence, 'policy'|'status'> & {
  policy: typeof SECOND_BREAKOUT_POLICY; effectiveDate: typeof SECOND_BREAKOUT_EFFECTIVE_DATE;
  status: 'waiting'|'unknown'|'weak_waiting'|'passed'; evaluatedMs: number;
  firstDelta?: number; firstThreshold?: number; priorHigh?: number; triggerMs?: number;
  triggerKind?: 'first'|'second'; signals: SecondBreakoutSignal[];
  authorization?: SwingEntryDecision;
}
export function secondBreakoutEnabled(date: string) { return date >= SECOND_BREAKOUT_EFFECTIVE_DATE }
export function recoveryDeadline(date: string, signalMs: number) {
  // Preserve the existing final submission cutoff (last 13:20 signal's first minute).
  return Math.min(signalMs + 30*MIN, Date.parse(date+'T13:21:00+08:00'))
}

/** Replay only completed bars. All structural qualification stays in the original OR15 evaluator. */
export function assessSecondBreakout(input: SwingEntryInput, priorLastTR?: number): SecondBreakoutEvidence {
  const first = assessAtrOnce(input, priorLastTR)
  const open = Date.parse(input.tradeDate+'T09:00:00+08:00')
  const end = Math.min(open+260*MIN, open+Math.floor((input.nowMs-open)/(5*MIN))*5*MIN)
  const result: SecondBreakoutEvidence = {...first, policy:SECOND_BREAKOUT_POLICY,
    effectiveDate:SECOND_BREAKOUT_EFFECTIVE_DATE, status:first.status==='veto'?'weak_waiting':first.status,
    evaluatedMs:end, firstDelta:first.delta, firstThreshold:first.threshold, signals:[]}
  if (!first.firstSignalMs || first.status==='unknown') return result
  const initial: SecondBreakoutSignal = {signalMs:first.firstSignalMs,close:first.close!,delta:first.delta!,
    atr5:first.atr5!,threshold:first.threshold!,priorHigh:null,newHigh:false,
    rWouldTrigger:first.status==='passed',sWouldTrigger:first.status==='passed',legacyWouldBuy:first.status==='passed'}
  result.signals.push(initial)
  if (first.status==='passed') return {...result,triggerMs:first.firstSignalMs,triggerKind:'first'}
  result.reason='swing_second_breakout_waiting'
  const byTime = new Map(input.bars.map(b=>[b.startMs-(input.label==='end'?MIN:0),b]))
  for (let ms=first.firstSignalMs+5*MIN;ms<=end;ms+=5*MIN) {
    const structural=assessSwingEntry({...input,nowMs:ms,quote:{price:input.previousClose,observedAtMs:ms}})
    const conditions=structural.conditions??{}
    if (['bars','ma60','or_touch','vwap','relative_strength','opening_limit'].some(k=>typeof conditions[k]!=='boolean'))
      return {...result,status:'unknown',reason:'swing_atr_first_signal_evidence_missing'}
    if (['plan','position','ma60','or_touch','vwap','relative_strength','opening_limit'].some(k=>conditions[k]!==true)) continue
    const bars=Array.from({length:(ms-open)/MIN},(_,i)=>byTime.get(open+i*MIN)!)
    const priorBars=bars.slice((first.firstSignalMs-5*MIN-open)/MIN,-5)
    const priorHigh=Math.max(...priorBars.map(b=>b.high))
    const closes:number[]=[],trs:number[]=[]
    let previous=input.previousClose
    if (priorLastTR!=null && Number.isFinite(priorLastTR) && priorLastTR>=0) trs.push(priorLastTR)
    for(let i=0;i<bars.length;i+=5) {
      const block=bars.slice(i,i+5),close=block[4].close
      trs.push(Math.max(Math.max(...block.map(b=>b.high))-Math.min(...block.map(b=>b.low)),
        Math.abs(Math.max(...block.map(b=>b.high))-previous),Math.abs(Math.min(...block.map(b=>b.low))-previous)))
      closes.push(close);previous=close
    }
    const close=closes.at(-1)!,delta=close-closes.at(-4)!,atr5=trs.slice(-5).reduce((a,b)=>a+b,0)/5,threshold=1.5*atr5
    const rWouldTrigger=secondMomentumPasses(delta,atr5),newHigh=close>priorHigh,sWouldTrigger=rWouldTrigger&&newHigh
    const signal={signalMs:ms,close,delta,atr5,threshold,priorHigh,newHigh,rWouldTrigger,sWouldTrigger,legacyWouldBuy:false}
    result.signals.push(signal)
    Object.assign(result,{close,delta,atr5,threshold,priorHigh})
    if (sWouldTrigger) return {...result,status:'passed',reason:'swing_second_breakout_passed',triggerMs:ms,triggerKind:'second'}
  }
  // Next close must beat every intervening bar, including non-qualified bars and the latest completed bar.
  const highs=[...byTime].filter(([t])=>t>=first.firstSignalMs!-5*MIN && t<end).map(([,b])=>b.high)
  if(highs.length) result.priorHigh=Math.max(...highs)
  return result
}

/** A live-observed completed signal gets a durable, bounded authorization. Never invent a past authorization. */
export function authorizeSecondBreakout(input:SwingEntryInput,evidence:SecondBreakoutEvidence):SecondBreakoutEvidence {
  if(evidence.status!=='passed' || !evidence.triggerMs || input.nowMs<evidence.triggerMs || input.nowMs>=evidence.triggerMs+MIN)
    return evidence
  const signal=assessSwingEntry({...input,nowMs:evidence.triggerMs,quote:{price:input.previousClose,observedAtMs:evidence.triggerMs}})
  if(['plan','position','bars','ma60','or_touch','vwap','relative_strength','opening_limit'].some(k=>signal.conditions?.[k]!==true)) return evidence
  const authorization:SwingEntryDecision={...signal,action:'pass',reason:'swing_saved_signal',
    signalKey:`${input.tradeDate}:${evidence.triggerMs}`,submitUntilMs:recoveryDeadline(input.tradeDate,evidence.triggerMs),
    recoveryPolicy:SECOND_BREAKOUT_POLICY,
    conditions:{...signal.conditions,quote:null,buy_limit:null,chase:null},quotePrice:undefined,quoteObservedAtMs:undefined}
  delete authorization.quotePrice
  delete authorization.quoteObservedAtMs
  return {...evidence,authorization}
}

/** No new ATR/structural signal during recovery. Refresh price/plan checks; all allocator/order guards still run. */
export function recoverSecondBreakout(evidence:SecondBreakoutEvidence,input:{nowMs:number;price:number;observedAtMs:number;planReady:boolean;candidateAllowed:boolean}):SwingEntryDecision|null {
  const saved=evidence.authorization
  if(!saved || evidence.status!=='passed') return null
  const conditions={...saved.conditions,plan:input.planReady&&input.candidateAllowed,position:null,
    window:input.nowMs>=saved.signalMs! && input.nowMs<saved.submitUntilMs!,
    quote:Number.isFinite(input.price)&&input.price>0&&Number.isFinite(input.observedAtMs)&&input.observedAtMs>=saved.signalMs!
      &&input.observedAtMs<=input.nowMs&&input.nowMs-input.observedAtMs<=90_000,
    buy_limit:input.price<saved.limitUp!,chase:input.price<=saved.maxBuyPrice!,atr_once:true}
  const reason=!conditions.plan?'swing_plan_not_authorized':!conditions.window?'swing_recovery_expired':
    !conditions.quote?'swing_fresh_execution_quote_missing':!conditions.buy_limit?'swing_buy_at_limit':!conditions.chase?'swing_chase_limit':'swing_saved_signal_recovery'
  return {...saved,atrOnce:evidence,conditions,quotePrice:input.price,quoteObservedAtMs:input.observedAtMs,assessedAtMs:input.nowMs,
    action:reason==='swing_saved_signal_recovery'?'pass':'defer',reason}
}
