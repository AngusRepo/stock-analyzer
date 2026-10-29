import type { Bindings } from '../types'
import { applySwingDecay, assessSwingExit, closeSwingSession, swingDecayEvidence, swingExitRules, SWING_DECAY_EXIT_POLICY,
  type SwingDecayEvidence, type SwingExitRules } from './paperSwingPolicy'
import { readSwingState, writeSwingState } from './paperSwingLifecycle'
import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { databaseForDataDomain } from './dataDomainRegistry'
import { writeSystemLog } from './notify'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import type { ExitDecision } from './paperExitPolicy'

/** The activated plan for one signal date, read once per evaluator. None yet means wait. */
async function activatedPlan(env:Bindings,signalDate:string) {
  const {results}=await paperDomainDatabase(env).prepare(
    'SELECT payload_json FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 AND signal_date=?')
    .bind(signalDate).all<{payload_json:string}>()
  if(!results?.length) return null
  if(results.length>1) return {ambiguous:true as const}
  return {plan:JSON.parse(results[0].payload_json)}
}

// Dates already alerted for invalid R33 exit rules, per isolate: polls rebuild the evaluator,
// so this caps the alert at one row per date per isolate rather than one per poll.
const rulesAlertedDates=new Set<string>()

/** One batch of daily prices per polling invocation; no LLM/optimizer calls. */
export function swingExitEvaluator(env:Bindings, positions:{symbol:string;trade_lifecycle_json?:unknown}[], date:string,
  cfg:Parameters<typeof swingExitRules>[0]) {
  let evidence: ReturnType<typeof loadMarketPriceHistoryBySymbols> | undefined
  const plans=new Map<string,ReturnType<typeof activatedPlan>>()
  return async (pos:{symbol:string;trade_lifecycle_json?:unknown}, price:number):Promise<ExitDecision|null> => {
    let state=readSwingState(pos.trade_lifecycle_json)
    if(!state) return null
    let rules:SwingExitRules
    try { rules=swingExitRules(cfg) } catch(error) {
      // A malformed R33 exit config is never replaced by built-in values.
      const reason=String(error instanceof Error ? error.message : error)
      console.warn('[SwingExit] '+reason)
      if(!rulesAlertedDates.has(date)) {
        rulesAlertedDates.add(date)
        try {
          await writeSystemLog(databaseForDataDomain(env,'ops'),'error','swing-exit','R33 swing exit rules invalid; swing exits held',{reason,date})
        } catch(logError) { console.warn('[SwingExit] alert not written: '+String(logError)) }
      }
      return {action:'hold',reason}
    }
    const nowMs=paperExecutionNow()
    // Price protection and already-durable exits survive missing daily data.
    if(state.pendingExit && nowMs>=state.pendingExit.notBeforeMs)
      return assessSwingExit(state,{date,nowMs,price,calendar:[]},rules)
    if(price<=state.entryPrice*rules.hardStopMultiplier) {
      const json=writeSwingState(pos.trade_lifecycle_json,{...state,pendingExit:{reason:'swing_hard_stop_8',notBeforeMs:nowMs}},rules)
      const result=await paperDomainDatabase(env).prepare(`UPDATE paper_positions SET trade_lifecycle_json=?
        WHERE account_id=? AND symbol=? AND trade_lifecycle_json=? AND shares>0`)
        .bind(json,paperAccountId(),pos.symbol,pos.trade_lifecycle_json).run()
      if(!result.success||result.meta.changes!==1) return {action:'hold',reason:'swing_exit_state_conflict'}
      pos.trade_lifecycle_json=json
      return assessSwingExit(readSwingState(json)!,{date,nowMs,price,calendar:[]},rules)
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
          observedAtMs:Date.parse(row.date+'T13:30:00+08:00'),nextSession,calendar},rules)
        state={...state,lastEvaluatedCloseDate:row.date}
        if(state.pendingExit) break
      }
      // R33 decay exit: the plan for the previous session carries this name's E-hat. It is
      // checked once per signal date; until that plan is activated the check waits.
      let shadow:{signalDate:string;evidence:SwingDecayEvidence;orl:Record<string,unknown>}|null=null
      const signalDate=calendar[calendar.indexOf(date)-1]
      if(rules.decay && !state.pendingExit && signalDate && signalDate>=state.entryDate && state.decayCheckedSignalDate!==signalDate) {
        if(!plans.has(signalDate)) plans.set(signalDate,activatedPlan(env,signalDate))
        const found=await plans.get(signalDate)!
        // A plan still missing after today's close is recorded as a skip rather than waited on forever.
        if(found || nowMs>=Date.parse(date+'T13:30:00+08:00')) {
          const decay=!found ? {skip:'ehat_plan_missing'} : ('ambiguous' in found) ? {skip:'ehat_plan_ambiguous'}
            : swingDecayEvidence(found.plan,pos.symbol,signalDate)
          state=applySwingDecay(state,decay,{signalDate,openMs:Date.parse(date+'T09:05:00+08:00')})
          // The retired ORL rule is still computed every day as the comparison arm.
          const bar=rows.find(r=>r.symbol===pos.symbol && r.date===signalDate)
          const factor=(state.priceAdjustments??[]).filter(a=>a.effectiveDate>signalDate).reduce((v,a)=>v*a.factor,1)
          const close=bar ? Number(bar.close)*factor : null
          shadow={signalDate,evidence:decay,orl:{rule:'swing_daily_orl',close_date:signalDate,close,entry_or_low:state.entryOrLow,
            would_exit:close===null ? null : close<state.entryOrLow}}
        }
      }
      const decision=assessSwingExit(state,{date,nowMs,price,calendar},rules)
      // Save an unfilled day-20 exit before fetching depth; retries cannot lose it.
      if(decision.reason==='swing_20_sessions' && !state.pendingExit)
        state={...state,pendingExit:{reason:'swing_20_sessions',notBeforeMs:nowMs}}
      if(JSON.stringify(state)!==before) {
        const previous=pos.trade_lifecycle_json
        const json=writeSwingState(previous,state,rules)
        const result=await paperDomainDatabase(env).prepare(`UPDATE paper_positions SET trade_lifecycle_json=?
          WHERE account_id=? AND symbol=? AND trade_lifecycle_json=? AND shares>0`)
          .bind(json,paperAccountId(),pos.symbol,previous).run()
        if(!result.success || result.meta.changes!==1) throw new Error('swing_exit_state_conflict')
        pos.trade_lifecycle_json=json
        if(shadow) await logDecayCheck(env,pos.symbol,date,state,shadow)
      }
      return decision
    } catch(error) {
      // No fall-through to legacy TP/ML exits on a missing calendar or daily bar.
      return {action:'hold',reason:'swing_daily_evidence_wait:'+String(error)}
    }
  }
}

/** One row per held name and signal date: the decay decision (or its exit_skip_reason) and the ORL arm. */
async function logDecayCheck(env:Bindings,symbol:string,date:string,state:{pendingExit?:{reason:string}},
  shadow:{signalDate:string;evidence:SwingDecayEvidence;orl:Record<string,unknown>}) {
  const decayed=state.pendingExit?.reason==='swing_ehat_decay'
  const reason='skip' in shadow.evidence ? 'exit_skip_reason:'+shadow.evidence.skip : decayed ? 'swing_ehat_decay' : 'swing_ehat_positive'
  await paperDomainDatabase(env).prepare(
    'INSERT INTO exit_shadow_log (ts, date, caller, symbol, regime, actual_action, actual_reason, hypothetical_order, hypothetical_mult) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(new Date(paperExecutionNow()).toISOString(),date,SWING_DECAY_EXIT_POLICY,symbol,'not_applicable',
      decayed ? 'pending_exit' : 'skip' in shadow.evidence ? 'skip' : 'hold',reason,JSON.stringify(shadow.orl),
      JSON.stringify({signal_date:shadow.signalDate,ehat:'ehat' in shadow.evidence ? shadow.evidence.ehat : null}))
    .run().catch((error:unknown)=>console.warn('[SwingExit] exit_shadow_log insert failed: '+String(error)))
}
