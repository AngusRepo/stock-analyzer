import type { Bindings } from '../types'
import type { PendingBuy } from './pendingBuyStore'
import type { IntradayOHLC } from './paperIntradayData'
import { assessSwingEntry, SWING_POLICY_VERSION, SWING_LAST_ENTRY_MINUTE_FROM_OPEN, type SwingEntryDecision } from './paperSwingPolicy'
import { loadSwingMinuteBars, loadOr15ResearchSessionBars, loadAtrTickWarmupBars } from './s12RuntimeBars'
import { assessAtrOnce, applyAtrOnce, previousAtrTR } from './paperAtrOnce'
import { readAtrOnce, latchAtrOnce } from './paperAtrOnceState'
import { paperExecutionNow, paperAccountId } from './paperExecutionScope'
import { executionBookTimingAges } from './executionBookTiming'
import { getPrevTradingDay } from './paperMarketData'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'
import { dailyPlanOwner, readL4ExecutionPlan as readL4PortfolioPlan } from './paperDailyPlanRuntime'
import { planIdFromWatchPoints } from './l4PortfolioPlan'
import { loadMarketPriceHistoryBySymbols, loadPreviousMarketCloseBySymbols } from './stockIdentityMarketBridge'
import { normalizeTwLimitPrice } from './twMarketRules'
import { resolveTwEquityPriceBand } from './twEquityMarketContract'

export interface SwingAssessmentReceipt { assessment: SwingEntryDecision; barSource: string; barError: string | null }

/** Signal evidence is independent of account valuation and executable-book availability. */
export function createSwingEntryAssessor(env: Bindings, today: string, maxChasePct: number) {
  let swingBenchmark: Promise<{bars: Awaited<ReturnType<typeof loadSwingMinuteBars>>; closes: Awaited<ReturnType<typeof loadMarketPriceHistoryBySymbols>>}> | undefined
  return async (pending: PendingBuy, price: number, currentOhlc?: IntradayOHLC | null): Promise<SwingAssessmentReceipt> => {
    let barError: string | null = null
    try {
        const sinceOpen=paperExecutionNow()-Date.parse(today+'T09:00:00+08:00')
        if(sinceOpen<20*60000 || sinceOpen>=(SWING_LAST_ENTRY_MINUTE_FROM_OPEN+1)*60000 || sinceOpen%(5*60000)>=60000) {
          const reason=sinceOpen<20*60000?'swing_entry_window_not_open':sinceOpen>=(SWING_LAST_ENTRY_MINUTE_FROM_OPEN+1)*60000?'swing_entry_window_closed':'swing_waiting_next_bar'
          let assessment:SwingEntryDecision={action:'defer',reason,policy:SWING_POLICY_VERSION,conditions:{window:false}}
          const atr=await readAtrOnce(paperDomainDatabase(env),paperAccountId(),today,pending.symbol)
          if(atr) assessment=applyAtrOnce(assessment,atr)
          return {assessment,barSource:'unavailable',barError:null}
        }
        swingBenchmark ??= Promise.all([loadSwingMinuteBars(env,'0050',today),
          loadMarketPriceHistoryBySymbols(env,['0050'],{beforeDate:today,rowsPerSymbol:60,requireQuerySuccess:true})])
          .then(([bars,closes])=>({bars,closes}))
        const [minute,benchmark,previousSession]=await Promise.all([loadSwingMinuteBars(env,pending.symbol,today),
          swingBenchmark,getPrevTradingDay(databaseForDataDomain(env,'core'),env.KV,today)])
        const orHigh=Math.max(...minute.bars.filter(b=>b.startMs>=Date.parse(today+'T09:00:00+08:00')
          && b.startMs<Date.parse(today+'T09:15:00+08:00')).map(b=>b.high))
        const reference=Number(currentOhlc?.referencePrice ?? (await loadPreviousMarketCloseBySymbols(env,[pending.symbol],today)).get(pending.symbol)?.close)
        const maxBuyPrice=normalizeTwLimitPrice(orHigh*(1+maxChasePct),'buy')
        const observedTiming=currentOhlc?.timingReceipt
          ? executionBookTimingAges(currentOhlc.timingReceipt,paperExecutionNow()) : null
        const observedAge=currentOhlc?.confirmationMode === 'quote_session_static_book'
          ? observedTiming?.quoteAgeMs : observedTiming?.sourceAgeMs
        const swingInput={tradeDate:today,nowMs:paperExecutionNow(),label:'start' as const,bars:minute.bars,
          benchmarkBars:benchmark.bars.bars,previousClose:reference,
          benchmarkPreviousClose:Number(benchmark.closes.find(r=>r.date===previousSession)?.close),
          benchmarkPriorCloses:benchmark.closes.map(r=>({date:r.date,close:Number(r.close)})),previousSession,
          quote:{price,observedAtMs:currentOhlc?.timingReceipt
            ? paperExecutionNow() - (observedAge ?? NaN)
            : Date.parse(currentOhlc?.confirmationMode === 'quote_session_static_book'
              ? currentOhlc.confirmationTime ?? '' : currentOhlc?.quoteTime ?? '')},
          limitUp:resolveTwEquityPriceBand(reference).limitUp ?? NaN,maxBuyPrice,
          boughtToday:false,alreadyHeld:false,planReady:dailyPlanOwner(env)&&Boolean((await readL4PortfolioPlan(env))?.execution_review),
          candidateAllowed:Boolean(planIdFromWatchPoints(pending.watch_points))}
        let assessment=assessSwingEntry(swingInput)
        const db=paperDomainDatabase(env), account=paperAccountId()
        let atr=await readAtrOnce(db,account,today,pending.symbol)
        if(!atr || atr.status==='unknown') {
          let candidate=assessAtrOnce(swingInput)
          if(candidate.reason==='swing_atr_warmup_missing') {
            try {
            // Immutable previous-session bars are cached by date, never re-fetched each minute.
            const key=`paper:atr5-prior:v2:${previousSession}:${pending.symbol}`
            let history:Awaited<ReturnType<typeof loadOr15ResearchSessionBars>>
            const cached=await env.KV.get(key).catch(()=>null)
            if(cached) history=JSON.parse(cached)
            else {
              history=await loadOr15ResearchSessionBars(env,pending.symbol,previousSession)
            }
            if(previousAtrTR(history.map(b=>({...b,startMs:b.startMs-60000})),previousSession,1,1)==null)
              history=await loadAtrTickWarmupBars(env,pending.symbol,previousSession)
            if(previousAtrTR(history.map(b=>({...b,startMs:b.startMs-60000})),previousSession,1,1)!=null)
              await env.KV.put(key,JSON.stringify(history),{expirationTtl:86400}).catch(()=>{
                console.warn('[ATR] prior-minute cache unavailable; using verified broker bars')
              })
            const prior=await loadMarketPriceHistoryBySymbols(env,[pending.symbol],{beforeDate:today,rowsPerSymbol:1,requireQuerySuccess:true})
            const rawClose=Number(prior.find(r=>r.date===previousSession)?.close)
            const tr=previousAtrTR(history.map(b=>({...b,startMs:b.startMs-60000})),previousSession,rawClose,reference)
            candidate=assessAtrOnce(swingInput,tr)
            } catch(error) {
              barError='atr_warmup:'+String(error)
              // Save the unknown FIRST signal even when the history provider is unavailable.
            }
          }
          // An unknown first signal may only be repaired at the same timestamp.
          if(atr?.firstSignalMs && candidate.firstSignalMs!==atr.firstSignalMs)
            throw new Error('swing_atr_first_signal_conflict')
          atr=await latchAtrOnce(db,account,today,pending.symbol,candidate)
        }
        assessment=applyAtrOnce(assessment,atr)
        // This sidecar receives placeholders for position state; the allocator/intent gate owns that check.
        if (assessment.conditions) assessment.conditions.position = null
        return {assessment,barSource:minute.source,barError}
    } catch (error) {
      return {assessment:{action:'defer',reason:'or15_market_data_unavailable',policy:SWING_POLICY_VERSION},
        barSource:'unavailable',barError:String(error)}
    }
  }
}
