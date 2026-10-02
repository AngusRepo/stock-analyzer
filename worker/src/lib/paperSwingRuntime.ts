import type { Bindings } from '../types'
import { assessSwingExit, closeSwingSession } from './paperSwingPolicy'
import { readSwingState, writeSwingState } from './paperSwingLifecycle'
import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import type { ExitDecision } from './paperExitPolicy'

/** One batch of daily prices per polling invocation; no LLM/optimizer calls. */
export function swingExitEvaluator(env:Bindings, positions:{symbol:string;trade_lifecycle_json?:unknown}[], date:string) {
  let evidence: ReturnType<typeof loadMarketPriceHistoryBySymbols> | undefined
  return async (pos:{symbol:string;trade_lifecycle_json?:unknown}, price:number):Promise<ExitDecision|null> => {
    let state=readSwingState(pos.trade_lifecycle_json)
    if(!state) return null
    const nowMs=paperExecutionNow()
    // Price protection and already-durable exits survive missing daily data.
    if(state.pendingExit && nowMs>=state.pendingExit.notBeforeMs)
      return assessSwingExit(state,{date,nowMs,price,calendar:[]})
    if(price<=state.entryPrice*.92) {
      const json=writeSwingState(pos.trade_lifecycle_json,{...state,pendingExit:{reason:'swing_hard_stop_8',notBeforeMs:nowMs}})
      const result=await paperDomainDatabase(env).prepare(`UPDATE paper_positions SET trade_lifecycle_json=?
        WHERE account_id=? AND symbol=? AND trade_lifecycle_json=? AND shares>0`)
        .bind(json,paperAccountId(),pos.symbol,pos.trade_lifecycle_json).run()
      if(!result.success||result.meta.changes!==1) return {action:'hold',reason:'swing_exit_state_conflict'}
      pos.trade_lifecycle_json=json
      return assessSwingExit(readSwingState(json)!,{date,nowMs,price,calendar:[]})
    }
    try {
      evidence ??= loadMarketPriceHistoryBySymbols(env,['0050',...positions.filter(p=>readSwingState(p.trade_lifecycle_json)).map(p=>p.symbol)],
        {beforeDate:date,rowsPerSymbol:260,requireQuerySuccess:true})
      const rows=await evidence
      const calendar=[...new Set(rows.filter(r=>r.symbol==='0050').map(r=>r.date)),date].sort()
      // Cross-check the exchange holiday cache against actual benchmark sessions.
      // A missing weekday is missing evidence, never a silently shortened holding period.
      for(let ms=Date.parse(state.entryDate+'T00:00:00Z');ms<Date.parse(date+'T00:00:00Z');ms+=86400000) {
        const d=new Date(ms),day=d.toISOString().slice(0,10)
        if(![0,6].includes(d.getUTCDay()) && !calendar.includes(day) && !await env.KV.get('holiday:'+day))
          throw new Error('swing_calendar_session_missing:'+day)
      }
      const before=JSON.stringify(state)
      const closes=rows.filter(r=>r.symbol===pos.symbol && r.date>=state!.entryDate && (!state!.lastEvaluatedCloseDate || r.date>state!.lastEvaluatedCloseDate)).sort((a,b)=>a.date.localeCompare(b.date))
      for(const row of closes) {
        const nextSession=calendar[calendar.indexOf(row.date)+1]
        if(!nextSession) throw new Error('swing_next_session_evidence_missing')
        const factor=(state.priceAdjustments??[]).filter(a=>a.effectiveDate>row.date).reduce((v,a)=>v*a.factor,1)
        state=closeSwingSession(state,{date:row.date,close:Number(row.close)*factor,
          observedAtMs:Date.parse(row.date+'T13:30:00+08:00'),nextSession,calendar})
        state={...state,lastEvaluatedCloseDate:row.date}
        if(state.pendingExit) break
      }
      const decision=assessSwingExit(state,{date,nowMs,price,calendar})
      // Save an unfilled day-20 exit before fetching depth; retries cannot lose it.
      if(decision.reason==='swing_20_sessions' && !state.pendingExit)
        state={...state,pendingExit:{reason:'swing_20_sessions',notBeforeMs:nowMs}}
      if(JSON.stringify(state)!==before) {
        const previous=pos.trade_lifecycle_json
        const json=writeSwingState(previous,state)
        const result=await paperDomainDatabase(env).prepare(`UPDATE paper_positions SET trade_lifecycle_json=?
          WHERE account_id=? AND symbol=? AND trade_lifecycle_json=? AND shares>0`)
          .bind(json,paperAccountId(),pos.symbol,previous).run()
        if(!result.success || result.meta.changes!==1) throw new Error('swing_exit_state_conflict')
        pos.trade_lifecycle_json=json
      }
      return decision
    } catch(error) {
      // No fall-through to legacy TP/ML exits on a missing calendar or daily bar.
      return {action:'hold',reason:'swing_daily_evidence_wait:'+String(error)}
    }
  }
}
