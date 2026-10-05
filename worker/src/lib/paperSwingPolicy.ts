/** Pure candidate policy. Activation requires the versioned account/runtime adapter. */
import type { Or15Bar } from './or15VwapEntry'
export const SWING_POLICY_VERSION = 'or15-5m-orl8-20-v1' as const
export const SWING_LAST_ENTRY_MINUTE_FROM_OPEN = 260 // 13:20; final signal starts 13:15.
const MIN = 60_000
const time = (date: string, clock: string) => Date.parse(`${date}T${clock}:00+08:00`)
const positive = (x: number) => Number.isFinite(x) && x > 0
export type SwingMinute = Or15Bar & { amount?: number }
export type SwingEntryInput = {
  tradeDate: string; nowMs: number; label: 'start' | 'end'; bars: SwingMinute[]; benchmarkBars: SwingMinute[];
  previousClose: number; benchmarkPreviousClose: number;
  benchmarkPriorCloses: { date: string; close: number }[]; previousSession: string;
  quote: { price: number; observedAtMs: number }; limitUp: number; maxBuyPrice: number;
  boughtToday: boolean; alreadyHeld: boolean; planReady: boolean; candidateAllowed: boolean;
}
export type SwingEntryDecision = {
  atrOnce?: import('./paperAtrOnce').AtrOnceEvidence;
  action: 'pass' | 'defer'; reason: string; policy: typeof SWING_POLICY_VERSION;
  signalMs?: number; signalKey?: string; submitUntilMs?: number; orHigh?: number; orLow?: number;
  conditions?: Record<string, boolean | null>; signalHigh?: number; signalClose?: number; maxBuyPrice?: number; quotePrice?: number;

  stockReturn?: number; benchmarkReturn?: number; previousClose?: number; benchmarkClose?: number;
  benchmarkPreviousClose?: number; quoteObservedAtMs?: number; assessedAtMs?: number; limitUp?: number;
  vwap?: number; vwapBasis?: 'amount_volume' | 'five_minute_typical'; relativeReturn?: number; ma60?: number;
}
function normalize(rows: SwingMinute[], label: 'start' | 'end', open: number, end: number) {
  const result = new Map<number, SwingMinute>()
  for (const raw of rows) {
    const startMs = raw.startMs - (label === 'end' ? MIN : 0)
    if (startMs < open || startMs >= end) continue
    if (startMs % MIN !== 0 || ![raw.open,raw.high,raw.low,raw.close].every(positive)
      || !Number.isFinite(raw.volume) || raw.volume < 0 || raw.low > Math.min(raw.open,raw.close)
      || raw.high < Math.max(raw.open,raw.close) || (raw.amount != null && (!Number.isFinite(raw.amount) || raw.amount < 0)))
      throw new Error('invalid_minute')
    const bar = { ...raw, startMs }
    const prior = result.get(startMs)
    if (prior && JSON.stringify(prior) !== JSON.stringify(bar)) throw new Error('conflicting_minute')
    result.set(startMs,bar)
  }
  return result
}
export function assessSwingEntry(input: SwingEntryInput): SwingEntryDecision {
  const conditions: Record<string, boolean | null> = { plan: input.planReady && input.candidateAllowed, position: !input.boughtToday && !input.alreadyHeld, window: null, ma60: null, bars: null, or_touch: null, vwap: null, relative_strength: null, opening_limit: null, quote: null, buy_limit: null, chase: null }
  const wait = (reason: string, detail: Partial<SwingEntryDecision> = {}): SwingEntryDecision =>
    ({ action:'defer', reason, policy:SWING_POLICY_VERSION, conditions, ...detail })
  const open = time(input.tradeDate,'09:00')
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(open)) return wait('swing_invalid_time')
  if (!input.planReady || !input.candidateAllowed) return wait('swing_plan_not_authorized')
  if (input.boughtToday || input.alreadyHeld) return wait('swing_existing_position_or_daily_fill')
  const n = Math.floor((input.nowMs-open)/(5*MIN))
  const signalMs = open+n*5*MIN
  const signalStart = signalMs-5*MIN
  conditions.window = signalStart >= open+15*MIN && signalStart <= open+(SWING_LAST_ENTRY_MINUTE_FROM_OPEN-5)*MIN && input.nowMs-signalMs < MIN
  if (signalStart < open+15*MIN) return wait('swing_entry_window_not_open')
  if (signalStart > open+(SWING_LAST_ENTRY_MINUTE_FROM_OPEN-5)*MIN) return wait('swing_entry_window_closed')
  // One minute for live scheduling/quote arrival, never catch up a stale prior bar.
  if (input.nowMs-signalMs >= MIN) return wait('swing_next_bar_submission_missed',{signalMs})
  const closes=[...input.benchmarkPriorCloses].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60)
  if (closes.length!==60 || new Set(closes.map(r=>r.date)).size!==60 || closes.some(r=>r.date>=input.tradeDate || !positive(r.close))
    || closes.at(-1)?.date!==input.previousSession || !positive(input.benchmarkPreviousClose)
    || Math.abs(closes.at(-1)!.close-input.benchmarkPreviousClose)>1e-8) return wait('swing_ma60_evidence_missing')
  const ma60=closes.reduce((s,r)=>s+r.close,0)/60
  conditions.ma60 = input.benchmarkPreviousClose>ma60
  if (input.benchmarkPreviousClose<=ma60) return wait('swing_market_below_ma60',{ma60,benchmarkPreviousClose:input.benchmarkPreviousClose})
  if (!positive(input.previousClose) || !positive(input.maxBuyPrice) || !positive(input.limitUp)) return wait('swing_price_contract_missing')
  let bars:Map<number,SwingMinute>, benchmark:Map<number,SwingMinute>
  try { bars=normalize(input.bars,input.label,open,signalMs); benchmark=normalize(input.benchmarkBars,input.label,open,signalMs) }
  catch(error) { return wait(`swing_${(error as Error).message}`) }
  const minutes=Array.from({length:n*5},(_,i)=>bars.get(open+i*MIN))
  conditions.bars = !minutes.some(b=>!b)
  if (minutes.some(b=>!b)) return wait('swing_minutes_missing',{signalMs})
  const completed=minutes as SwingMinute[]
  const benchmarkClose=benchmark.get(signalMs-MIN)?.close
  if (!positive(benchmarkClose ?? 0)) return wait('swing_benchmark_timestamp_missing',{signalMs})
  const orHigh=Math.max(...completed.slice(0,15).map(b=>b.high)), orLow=Math.min(...completed.slice(0,15).map(b=>b.low))
  const last=completed.slice(-5), close=last[4].close
  const volume=completed.reduce((sum,b)=>sum+b.volume,0)
  if (volume<=0) return wait('swing_volume_missing',{orHigh,orLow,signalMs})
  const exact=completed.every(b=>b.amount!=null)
  let turnover=0
  if (exact) turnover=completed.reduce((s,b)=>s+b.amount!,0)
  else for(let i=0;i<completed.length;i+=5) {
    const block=completed.slice(i,i+5), qty=block.reduce((s,b)=>s+b.volume,0)
    turnover+=(Math.max(...block.map(b=>b.high))+Math.min(...block.map(b=>b.low))+block[4].close)/3*qty
  }
  const vwap=turnover/volume
  if (!positive(vwap) || vwap<Math.min(...completed.map(b=>b.low))-1e-8 || vwap>Math.max(...completed.map(b=>b.high))+1e-8)
    return wait('swing_turnover_volume_units_invalid',{signalMs})
  const relativeReturn=close/input.previousClose-benchmarkClose!/input.benchmarkPreviousClose
  const signalHigh=Math.max(...last.map(b=>b.high))
  Object.assign(conditions, { or_touch: signalHigh>=orHigh, vwap: close>=vwap, relative_strength: relativeReturn>=-1e-12, opening_limit: orHigh<input.limitUp,
    quote: positive(input.quote.price) && Number.isFinite(input.quote.observedAtMs) && input.quote.observedAtMs<=input.nowMs && input.quote.observedAtMs>=signalMs && input.nowMs-input.quote.observedAtMs<=90_000,
    buy_limit: positive(input.quote.price) ? input.quote.price<input.limitUp : null, chase: positive(input.quote.price) ? input.quote.price<=input.maxBuyPrice : null })
  const detail={stockReturn:close/input.previousClose-1,benchmarkReturn:benchmarkClose!/input.benchmarkPreviousClose-1,
    previousClose:input.previousClose,benchmarkClose:benchmarkClose!,benchmarkPreviousClose:input.benchmarkPreviousClose,
    quoteObservedAtMs:input.quote.observedAtMs,assessedAtMs:input.nowMs,limitUp:input.limitUp,
    signalMs,orHigh,orLow,vwap,relativeReturn,ma60,signalHigh,signalClose:close,maxBuyPrice:input.maxBuyPrice,quotePrice:input.quote.price,vwapBasis:exact?'amount_volume' as const:'five_minute_typical' as const}
  if (orHigh>=input.limitUp) return wait('swing_opening_range_at_limit',detail)
  if (Math.max(...last.map(b=>b.high))<orHigh) return wait('swing_waiting_or_touch',detail)
  if (close<vwap) return wait('swing_waiting_vwap',detail)
  if (relativeReturn < -1e-12) return wait('swing_waiting_relative_strength',detail)
  if (!positive(input.quote.price) || !Number.isFinite(input.quote.observedAtMs) || input.quote.observedAtMs>input.nowMs
    || input.quote.observedAtMs<signalMs || input.nowMs-input.quote.observedAtMs>90_000) return wait('swing_fresh_execution_quote_missing',detail)
  if (input.quote.price>=input.limitUp) return wait('swing_buy_at_limit',detail)
  if (input.quote.price>input.maxBuyPrice) return wait('swing_chase_limit',detail)
  return {action:'pass',reason:'swing_or15_vwap_relative_strength',policy:SWING_POLICY_VERSION,conditions,...detail,
    signalKey:`${input.tradeDate}:${signalMs}`,submitUntilMs:signalMs+MIN}
}

export type SwingPositionState = {
  policy: typeof SWING_POLICY_VERSION; entryDate: string; entryPrice: number; entryOrLow: number;
  lastEvaluatedCloseDate?: string;
  priceAdjustments?: {effectiveDate:string;factor:number}[];
  pendingExit?: {reason:'swing_daily_orl'|'swing_20_sessions'|'swing_hard_stop_8';notBeforeMs:number};
}
function sessionAge(state:SwingPositionState,date:string,calendar:string[]) {
  if (calendar.some((d,i)=>i>0&&d<=calendar[i-1]) || !calendar.includes(state.entryDate) || !calendar.includes(date))
    throw new Error('swing_trading_calendar_incomplete')
  return calendar.indexOf(date)-calendar.indexOf(state.entryDate)
}
export function closeSwingSession(state:SwingPositionState,input:{date:string;close:number;observedAtMs:number;nextSession:string;calendar:string[]}):SwingPositionState {
  if (!positive(input.close) || !Number.isFinite(input.observedAtMs) || input.observedAtMs<time(input.date,'13:30') || input.nextSession<=input.date)
    throw new Error('swing_daily_close_not_final')
  const age=sessionAge(state,input.date,input.calendar)
  if(age<0) throw new Error('swing_close_before_entry')
  if(state.pendingExit) return state
  if(age>=20) return {...state,pendingExit:{reason:'swing_20_sessions',notBeforeMs:time(input.date,'13:24')}}
  if(input.close<state.entryOrLow) return {...state,pendingExit:{reason:'swing_daily_orl',notBeforeMs:time(input.nextSession,'09:05')}}
  return state
}
export function assessSwingExit(state:SwingPositionState,input:{date:string;nowMs:number;price:number;calendar:string[]}) {
  if(state.policy!==SWING_POLICY_VERSION || !positive(state.entryPrice) || !positive(state.entryOrLow) || !positive(input.price))
    throw new Error('swing_position_invalid')
  // Hard protection never waits for calendar or daily-close evidence.
  if(input.price<=state.entryPrice*.92) return {action:'full_sell' as const,reason:'swing_hard_stop_8',exitIntentKind:'risk_stop' as const}
  // Scheduled expiry never submits during the closing auction. Keep its intent for the next session.
  const expiryWindow=input.nowMs>=time(input.date,'09:05') && input.nowMs<time(input.date,'13:25')
  if(state.pendingExit?.reason==='swing_20_sessions' && !expiryWindow)
    return {action:'hold' as const,reason:'swing_expiry_outside_continuous_session'}
  if(state.pendingExit && input.nowMs>=state.pendingExit.notBeforeMs) return {action:'full_sell' as const,
    reason:state.pendingExit.reason,exitIntentKind:state.pendingExit.reason==='swing_20_sessions' ? 'time_stop' as const : 'risk_stop' as const}
  if (!Number.isFinite(input.nowMs)) throw new Error('swing_exit_clock_invalid')
  const age=sessionAge(state,input.date,input.calendar)
  if(age<0) throw new Error('swing_exit_before_entry')
  if(age>=20 && expiryWindow && (age>20 || input.nowMs>=time(input.date,'13:24'))) return {action:'full_sell' as const,reason:'swing_20_sessions',exitIntentKind:'time_stop' as const}
  return {action:'hold' as const,reason:'swing_hold'}
}
