import {assessSwingEntry, type SwingEntryInput, type SwingEntryDecision, type SwingMinute} from './paperSwingPolicy'
export const ATR_ONCE_POLICY = 'atr5-sma-first-signal-v1' as const
export type AtrOnceEvidence = {
  policy: typeof ATR_ONCE_POLICY; status: 'waiting'|'unknown'|'passed'|'veto'; reason: string;
  firstSignalMs?: number; close?: number; close3?: number; delta?: number; atr5?: number; threshold?: number;
}
const MIN=60_000
/** Shared original signal evaluator; synthetic quote is used ONLY to inspect structure flags, never to authorize orders. */
export function assessAtrOnce(input:SwingEntryInput, priorLastTR?:number):AtrOnceEvidence {
  const base={policy:ATR_ONCE_POLICY}
  const open=Date.parse(input.tradeDate+'T09:00:00+08:00')
  const end=Math.min(open+260*MIN,Math.floor((input.nowMs-open)/(5*MIN))*5*MIN+open)
  for(let ms=open+20*MIN;ms<=end;ms+=5*MIN) {
    const signal=assessSwingEntry({...input,nowMs:ms,quote:{price:input.previousClose,observedAtMs:ms}})
    const c=signal.conditions??{}
    if(c.plan===false || c.position===false || c.ma60===false || c.opening_limit===false)
      return {...base,status:'waiting',reason:signal.reason}
    if(['bars','ma60','or_touch','vwap','relative_strength','opening_limit'].some(k=>typeof c[k]!=='boolean'))
      return {...base,status:'unknown',reason:'swing_atr_first_signal_evidence_missing'}
    if(!c.or_touch || !c.vwap || !c.relative_strength) continue
    const first={...base,firstSignalMs:ms}
    const rows=input.bars.map(b=>({...b,startMs:b.startMs-(input.label==='end'?MIN:0)}))
    const byTime=new Map(rows.map(b=>[b.startMs,b]))
    const closes:number[]=[],trs:number[]=[]
    if(priorLastTR!=null && Number.isFinite(priorLastTR) && priorLastTR>=0) trs.push(priorLastTR)
    let previous=input.previousClose
    for(let t=open;t<ms;t+=5*MIN) {
      const block=Array.from({length:5},(_,i)=>byTime.get(t+i*MIN)!)
      const high=Math.max(...block.map(b=>b.high)),low=Math.min(...block.map(b=>b.low)),close=block[4].close
      trs.push(Math.max(high-low,Math.abs(high-previous),Math.abs(low-previous)))
      closes.push(close);previous=close
    }
    const close=closes.at(-1)!,close3=closes.at(-4)!,delta=close-close3
    if(trs.length<5) return {...first,close,close3,delta,status:'unknown',reason:'swing_atr_warmup_missing'}
    const atr5=trs.slice(-5).reduce((a,b)=>a+b,0)/5,threshold=1.5*atr5
    const passed=delta>threshold+1e-10
    return {...first,close,close3,delta,atr5,threshold,status:passed?'passed':'veto',
      reason:passed?'swing_atr_first_passed':'swing_atr_day_veto'}
  }
  return {...base,status:'waiting',reason:'swing_atr_waiting_first_signal'}
}
/** Previous completed 13:20 block TR, adjusted to today's reference price basis; auction is excluded. */
export function previousAtrTR(bars:SwingMinute[],date:string,rawDailyClose:number,reference:number):number|undefined {
  if(![rawDailyClose,reference].every(x=>Number.isFinite(x)&&x>0)) return undefined
  const end=Date.parse(date+'T13:25:00+08:00'),byTime=new Map(bars.map(b=>[b.startMs,b]))
  const block=Array.from({length:5},(_,i)=>byTime.get(end-(5-i)*MIN))
  const prev=byTime.get(end-6*MIN)?.close
  if(!prev || block.some(b=>!b || ![b.high,b.low,b.close].every(x=>Number.isFinite(x)&&x>0))) return undefined
  const high=Math.max(...block.map(b=>b!.high)),low=Math.min(...block.map(b=>b!.low))
  if(high<low) return undefined
  return Math.max(high-low,Math.abs(high-prev),Math.abs(low-prev))*reference/rawDailyClose
}
export function applyAtrOnce(decision:SwingEntryDecision,evidence:AtrOnceEvidence):SwingEntryDecision {
  const conditions={...decision.conditions,atr_once:evidence.status==='passed'?true:evidence.status==='veto'?false:null}
  return {...decision,conditions,atrOnce:evidence,
    ...(evidence.status==='passed'?{}:{action:'defer' as const,reason:evidence.reason})}
}
