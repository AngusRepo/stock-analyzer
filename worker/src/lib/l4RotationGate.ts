import type { Bindings } from '../types'
import type { L4PortfolioPlan } from './l4PortfolioPlan'
import type { TradingConfig } from './tradingConfig'
import type { CircuitBreakerState } from './riskTypes'
import { paperAccountId,paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { createSwingEntryAssessor } from './paperSwingAssessment'
import { swingExecutionAuthorization } from './paperSwingExecution'
import { batchGetIntradayOHLC } from './paperIntradayData'
import { shioajiBookObservation } from './paperExecutionBook'
import { resolveAuthoritativeBuyExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { matchPaperOrderAgainstAuthoritativeDepth } from './paperOrderBookMatcher'
import { normalizeTwLimitPrice } from './twMarketRules'
import { loadMarketPriceHistoryBySymbols,loadPreviousMarketCloseBySymbols } from './stockIdentityMarketBridge'
import { assessPositionCorrelation } from './positionRiskDistribution'
import { validateOrder } from './validateOrder'
import { getRiskConfig } from './riskConfig'
import { getAvailableCash } from './dateUtils'
import { resolveCircuitAdjustedSingleNameCap } from './riskPositionSizing'
import { readL4EntryContinuation } from './l4EntryContinuation'
import { parseSellOrderNote as parsePaperOrderNote } from './paperOrderAccounting'

export interface RotationCandidateEvidence {grossCredit:number;preparedGross:number;validUntilMs?:number}
/** Credits are disjoint and sealed. One completed replacement is not an unlimited sell grant. */
export function rotationCreditsSatisfied(credits:Array<{symbol:string;credit_start:number;credit_end:number}>,evidence:Record<string,RotationCandidateEvidence>,nowMs:number) {
  return credits.length>0 && credits.every(c=>{
    const e=evidence[c.symbol]
    return e && e.grossCredit+(e.validUntilMs!=null && nowMs<e.validUntilMs ? e.preparedGross : 0)>=c.credit_end-1e-6
  })
}

/** Check only preselected legs. This does NOT optimize, create an order, or find a replacement. */
export async function checkL4RotationGate(env:Bindings,input:{plan:L4PortfolioPlan;symbol:string;reduceShares:number;
  positions:any[];prices:Map<string,number>;nav:number;cfg:TradingConfig;risk:CircuitBreakerState}):Promise<{
    satisfied:boolean;reason:string;validUntilMs?:number;evidence?:Record<string,RotationCandidateEvidence>}> {
  const {plan,symbol,cfg,risk}=input,rule=plan.sealed_execution?.exit_rules[symbol]
  if(!rule || rule.mode==='unconditional')return {satisfied:true,reason:'unconditional'}
  if(rule.mode==='retain_until_next_seal' || !plan.execution_review)return {satisfied:false,reason:'retain_until_next_seal'}
  const db=paperDomainDatabase(env),date=plan.execution_review.tradeDate,evidence:Record<string,RotationCandidateEvidence>={}
  const targets=[...new Set(rule.credits!.map(c=>c.symbol))]
  for(const replacement of targets) {
    const {results:orders}=await db.prepare(`SELECT shares,price,note FROM paper_orders WHERE account_id=? AND symbol=? AND side='buy'
      AND created_at>=? AND created_at<? ORDER BY id`).bind(paperAccountId(),replacement,date+' 00:00:00',date+' 23:59:59')
      .all<{shares:number;price:number;note:string}>()
    const fills=orders.filter(o=>parsePaperOrderNote(o.note).l4_plan_id===plan.plan_id)
    const qty=fills.reduce((n,o)=>n+Number(o.shares),0),gross=fills.reduce((n,o)=>n+Number(o.shares)*Number(o.price),0)
    const holding=input.positions.find(p=>p.symbol===replacement && p.entry_date===date)
    // Credits disappear if the replacement has since exited. Price appreciation is not a fill.
    const retained=Math.min(qty,Number(holding?.shares ?? 0))
    evidence[replacement]={grossCredit:qty>0?gross*retained/qty:0,preparedGross:0}
    const auth=fills.length?parsePaperOrderNote(fills[0].note).entry_authorization as {requestedShares:number;maxPrice:number}|undefined:null
    if(auth && retained===qty && qty===auth.requestedShares)
      evidence[replacement].grossCredit+=Number(auth.maxPrice) // One legal-share rounding allowance, once per leg.
  }
  if(rotationCreditsSatisfied(rule.credits!,evidence,paperExecutionNow()))return {satisfied:true,reason:'selected_fills_confirmed'}
  if(risk.halt || env.PAPER_INTRADAY_ENTRY_OWNER!=='or15-5m-orl8-20-v1')return {satisfied:false,reason:'replacement_entry_not_allowed'}
  const riskCfg=await getRiskConfig(env.KV)
  if(riskCfg.system.killSwitch)return {satisfied:false,reason:'kill_switch'}
  const pending=(await loadPendingBuySnapshot(env,date,{allowFallbackRecent:false})).pendingBuys
  const assessor=createSwingEntryAssessor(env,date,cfg.position.maxEntryChasePct)
  const after=input.positions.map(p=>({...p,shares:Number(p.shares)-(p.symbol===symbol?input.reduceShares:0)})).filter(p=>p.shares>0)
  const simulationPrices=new Map(input.prices)
  let afterValue=after.reduce((n,p)=>n+p.shares*(simulationPrices.get(p.symbol)??NaN),0)
  const exitValue=input.reduceShares*(input.prices.get(symbol)??NaN)
  let nav=input.nav-exitValue*(cfg.fees.commission+cfg.fees.tax)-cfg.fees.minCommission
  let available=await getAvailableCash(db,paperAccountId())+exitValue*(1-cfg.fees.commission-cfg.fees.tax)-cfg.fees.minCommission
  const limits=await db.prepare("SELECT COUNT(DISTINCT COALESCE(CASE WHEN json_valid(note) THEN json_extract(note,'$.entry_authorization.id') END,'order:'||id)) AS n,COALESCE(SUM(total_cost),0) AS spent FROM paper_orders WHERE account_id=? AND side='buy' AND created_at>=?")
    .bind(paperAccountId(),date).first<{n:number;spent:number}>()
  let entryCount=limits?.n??0,spent=limits?.spent??0
  const stocks=await databaseForDataDomain(env,'core').prepare(`SELECT symbol,sector FROM stocks WHERE symbol IN (${[...after.map(p=>p.symbol),...targets].map(()=>'?').join(',')})`)
    .bind(...after.map(p=>p.symbol),...targets).all<{symbol:string;sector:string|null}>()
  const sectors=new Map(stocks.results.map(p=>[p.symbol,p.sector??'UNKNOWN']))
  const nameCap=resolveCircuitAdjustedSingleNameCap({configuredSingleNameCap:riskCfg.position.maxSingleNamePct,
    circuitBaselinePositionPct:cfg.circuit.maxPositionPct,circuitEffectivePositionPct:risk.maxPositionPct})
  let deadline=Infinity
  for(const replacement of targets) {
    if(evidence[replacement].grossCredit>=Math.max(...rule.credits!.filter(c=>c.symbol===replacement).map(c=>c.credit_end)))continue
    const candidate=pending.find(p=>p.symbol===replacement && p.watch_points.includes('l4_plan:'+plan.plan_id))
    if(!candidate || (plan.execution_review.weights[replacement] ?? 0)<=0)continue
    const held=after.find(p=>p.symbol===replacement)
    const continuation=held?await readL4EntryContinuation(env,date,replacement,plan.plan_id,plan.execution_review.checksum):null
    if(held && !continuation)continue
    if(!held && (after.length>=Math.min(cfg.position.maxPositions,plan.constraints.max_positions??Infinity) || entryCount>=riskCfg.order.maxDailyBuyOrders))continue
    const sector=sectors.get(replacement)??'UNKNOWN'
    if(!held && after.filter(p=>(sectors.get(p.symbol)??'UNKNOWN')===sector).length>=riskCfg.position.maxPerSector)continue
    const books=await batchGetIntradayOHLC([replacement],{...env,marketDataLotType:'odd_lot'})
    let book=books.get(replacement)
    if(!book || book.ask==null || book.last<=0)continue
    const assessment=(await assessor(candidate,book.last,book)).assessment,auth=swingExecutionAuthorization(assessment)
    if(!auth || paperExecutionNow()>=auth.submitUntilMs || book.ask>auth.maxBuyPrice)continue
    book=(await batchGetIntradayOHLC([replacement],{...env,marketDataLotType:'odd_lot'})).get(replacement)
    if(!book || book.ask==null || book.ask>auth.maxBuyPrice)continue
    const ceiling=Math.min(auth.maxBuyPrice,continuation?.authorization.maxPrice??Infinity)
    const groupBudget=Object.values(plan.constraints.exposure_groups??{}).filter(g=>g.symbols.includes(replacement))
      .map(g=>g.effective_cap*nav-after.filter(p=>g.symbols.includes(p.symbol)).reduce((n,p)=>n+p.shares*(simulationPrices.get(p.symbol)??NaN),0))
    const budget=Math.min(...groupBudget,(Math.min(plan.execution_review.weights[replacement],nameCap)*nav-(held?.shares??0)*book.last),
      Math.min(plan.constraints.exposure_cap,risk.targetExposurePct??0)*nav-afterValue,
      (available-cfg.fees.minCommission)/(1+cfg.fees.commission),(cfg.position.dailyBuyLimit-spent-cfg.fees.minCommission)/(1+cfg.fees.commission))
    let quantity=Math.floor(budget/book.ask)
    if(!held && budget<cfg.position.minPositionValue)continue
    if(continuation)quantity=Math.min(quantity,continuation.remainingShares)
    if(quantity<1)continue
    if(quantity>=1000) {
      book=(await batchGetIntradayOHLC([replacement],{...env,marketDataLotType:'board_lot'})).get(replacement)
      quantity=Math.floor(quantity/1000)*1000
    }
    const lotType=quantity>=1000?'board_lot' as const:'odd_lot' as const
    if(!book || book.ask==null)continue
    const limitPrice=normalizeTwLimitPrice(Math.min(ceiling,book.ask),'buy')
    const snapshot=resolveAuthoritativeBuyExecutionSnapshot({limitPrice,lotType:quantity>=1000?'board_lot':'odd_lot',
      maxAgeMs:Number((env as any).EXECUTION_BOOK_MAX_AGE_MS??1500),observations:[shioajiBookObservation(book)]})
    if(snapshot.status!=='ready')continue
    const rows=await loadMarketPriceHistoryBySymbols(env,[replacement,...after.map(p=>p.symbol)],{beforeDate:date,rowsPerSymbol:riskCfg.position.correlationWindow+1})
    if(assessPositionCorrelation({candidateSymbol:replacement,holdingSymbols:after.map(p=>p.symbol),
      priceRows:rows.filter(r=>r.close!=null).map(r=>({symbol:r.symbol,date:r.date,close:Number(r.close)})),threshold:riskCfg.position.correlationThreshold}).status==='blocked')continue
    const avg=rows.filter(r=>r.symbol===replacement && r.volume!=null).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20)
    const prev=(await loadPreviousMarketCloseBySymbols(env,[replacement],date)).get(replacement)
    const validation=await validateOrder({symbol:replacement,side:'buy',shares:quantity,limitPrice,refClose:prev?.close??null,
      avgVolume20d:avg.length?avg.reduce((n,r)=>n+Number(r.volume),0)/avg.length:null,
      sizingAuthorization:{owner:'sparse_allocator',authorizedValue:budget,portfolioValue:nav}},riskCfg)
    if(!validation.approved)continue
    quantity=Math.min(quantity,validation.adjustedOrder?.shares??quantity)
    quantity=lotType==='board_lot'?Math.floor(quantity/1000)*1000:Math.min(999,quantity)
    if(quantity<1)continue
    const fresh=(await batchGetIntradayOHLC([replacement],{...env,marketDataLotType:lotType})).get(replacement)
    if(!fresh)continue
    const current=resolveAuthoritativeBuyExecutionSnapshot({limitPrice,lotType,
      maxAgeMs:Number((env as any).EXECUTION_BOOK_MAX_AGE_MS??1500),observations:[shioajiBookObservation(fresh)]})
    if(current.status!=='ready')continue
    const depth=matchPaperOrderAgainstAuthoritativeDepth({snapshot:current,requestedShares:quantity,limitPrice})
    const expires=Math.min(auth.submitUntilMs,continuation?.authorization.expiresAtMs??Infinity,
      paperExecutionNow()+current.maxAgeMs-(current.ageMs??current.maxAgeMs))
    evidence[replacement].preparedGross=depth.filledShares*(depth.averageFillPrice??0)
    evidence[replacement].validUntilMs=expires;deadline=Math.min(deadline,expires)
    // Reserve every prepared leg against the same simulated post-sale account.
    // Independent checks must not spend the same cash, exposure or sector slot.
    if(depth.filledShares>0 && depth.averageFillPrice!=null) {
      const value=evidence[replacement].preparedGross,fee=Math.max(cfg.fees.minCommission,value*cfg.fees.commission)
      available-=value+fee;spent+=value+fee;nav-=fee
      simulationPrices.set(replacement,depth.averageFillPrice)
      if(held)held.shares+=depth.filledShares
      else {after.push({symbol:replacement,shares:depth.filledShares,entry_date:date});entryCount++}
      afterValue=after.reduce((n,p)=>n+p.shares*(simulationPrices.get(p.symbol)??NaN),0)
    }
  }
  return {satisfied:rotationCreditsSatisfied(rule.credits!,evidence,paperExecutionNow()),
    ...(Number.isFinite(deadline)?{validUntilMs:deadline}:{}),reason:'sealed_selected_entry_readiness',evidence}
}
