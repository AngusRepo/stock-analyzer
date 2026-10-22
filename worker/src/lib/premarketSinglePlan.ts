import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'
import { paperExecutionNow } from './paperExecutionScope'
import { readL4PortfolioPlan,planIdFromWatchPoints } from './l4PortfolioPlan'
import { readL4ExecutionPlan } from './paperDailyPlanRuntime'
import { sealDailyReview,persistDailyReview,type RiskRestriction } from './paperDailyPlan'
import { readCurrentNewsReport } from './newsAnalyst'
import { isReadyUSSignal } from './usLeading'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import type { PremarketPayload } from './premarketEventChain'
function stable(value:any):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}'
  return JSON.stringify(value)
}
async function checksum(value:any) {
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value)))))
   .map(x=>x.toString(16).padStart(2,'0')).join('')
}
export async function singlePlanContext(env:Bindings,date:string,signalDate:string) {
 const stage=await databaseForDataDomain(env,'ops').prepare("SELECT canonical_run_id FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution'")
   .bind(signalDate).first<{canonical_run_id:string}>()
 if(!stage)throw new Error('premarket_wait:l3_source')
 const seal=await controllerJson<{status:string;receipt:any}>(env,'/pipeline/v2/premarket-state?'+new URLSearchParams({date:signalDate,run_id:stage.canonical_run_id}))
 if(seal.status!=='sealed')throw new Error('premarket_wait:l3_seal')
 const [us,news]=await Promise.all([env.KV.get('us:leading:'+date,'json'),readCurrentNewsReport(env.KV,date)])
 if(!isReadyUSSignal(us,date)||!news?.evidence_receipt)throw new Error('premarket_wait:context')
 const body={trade_date:date,cutoff:new Date(paperExecutionNow()).toISOString(),us,news}
 const hash=await checksum(body)
 return {signal_date:signalDate,l3_receipt:seal.receipt,morning_context:{...body,checksum:hash},context_hash:hash}
}
export async function dispatchSinglePlan(env:Bindings,input:PremarketPayload) {
 const receipt=input.l3_receipt as {run_id:string;run_date:string}
 const row=await databaseForDataDomain(env,'ops').prepare("SELECT status FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution' AND canonical_run_id=?")
   .bind(receipt.run_date,receipt.run_id).first<{status:string}>()
 if(row?.status!=='success') {
 const status=await controllerJson<{status:string;reason?:string}>(env,'/pipeline/v2/premarket-resume',{
   method:'POST',jsonBody:{receipt:input.l3_receipt,context:input.morning_context},timeoutMs:60_000})
 if(status.status==='reconciliation_required')throw new Error(status.reason ?? 'premarket_dispatch_outcome_unknown')
 if(!['dispatching','dispatched','completed'].includes(status.status))throw new Error('premarket_dispatch_receipt_invalid')

 throw new Error('premarket_wait:l4_completion')
 }
 const plan=await readL4PortfolioPlan(env)
 if(!plan||plan.signal_date!==receipt.run_date)throw new Error('premarket_wait:l4_publication')
 return plan.plan_id
}
/** The daily head admits the sealed L4 plan and deterministic pending-buy checks. */
export async function finalizeSinglePlan(env:Bindings,date:string,input:PremarketPayload) {
 const plan=await readL4PortfolioPlan(env)
 if(!plan||plan.plan_id!==input.plan_id||plan.signal_date!==input.signal_date)throw new Error('daily_plan_source_changed')
 const state=await loadPendingBuySnapshot(env,date,{allowFallbackRecent:false})
 if(!['ready','empty','halted'].includes(String(state.meta?.status)) || state.pendingBuys.some(p=>
   planIdFromWatchPoints(p.watch_points)!==plan.plan_id))
   throw new Error('premarket_wait:pending_publication')
 const db=paperDomainDatabase(env)
 const rows=(await db.prepare("SELECT request_id,request_json FROM l4_replan_outbox_v1 WHERE source_plan_id=? AND status='pending' AND substr(json_extract(request_json,'$.reason'),1,7)!='debate_' ORDER BY request_id")
   .bind(plan.plan_id).all<{request_id:string;request_json:string}>()).results
 const restrictions:RiskRestriction[]=rows.flatMap(row=>{
   const r=JSON.parse(row.request_json)
   return [...r.veto_symbols.map((symbol:string)=>({symbol,maxWeight:0,reason:r.reason})),
     ...Object.entries(r.weight_caps??{}).map(([symbol,maxWeight])=>({symbol,maxWeight:Number(maxWeight),reason:r.reason}))]
 })
 // A complete halted publication is a veto of new allocations, not a fabricated liquidation of missing holdings.
 if(state.meta?.status==='halted')for(const [symbol,t]of Object.entries(plan.targets))
   if(!t.locked&&t.current_weight===0)restrictions.push({symbol,maxWeight:0,reason:'premarket_halted'})
 let review
 try {review=(await readL4ExecutionPlan(env))?.execution_review} catch(error) {
   if(!String(error).includes('daily_plan_not_finalized'))throw error
 }
 if(!review) {
   review=await sealDailyReview({plan,tradeDate:date,contextHash:String(input.context_hash),nowMs:paperExecutionNow(),restrictions})
   await persistDailyReview(db,plan,review)
 } else if(review.planId!==plan.plan_id||review.contextHash!==input.context_hash)throw new Error('daily_plan_publication_conflict')
 // A retry after the atomic head commit only acknowledges already-delivered caps.
 for(const r of restrictions)if(review.weights[r.symbol]>r.maxWeight)throw new Error('daily_plan_unpublished_cap')
 if(rows.length)await db.batch(rows.map(r=>db.prepare("UPDATE l4_replan_outbox_v1 SET status='completed',result_plan_id=? WHERE request_id=? AND status='pending'").bind(plan.plan_id,r.request_id)))
 return {...input,ready:true,plan_id:plan.plan_id,review_checksum:review.checksum,pending_run_id:state.meta?.run_id,
   pending_status:state.meta?.status,symbols:state.pendingBuys.map(p=>p.symbol)}
}
