import type { Bindings } from '../types'
import { databaseForDataDomain, databaseForTable } from './dataDomainRegistry'
import { postVerifyOwnerAckEvidence, postVerifyControllerResponse, type PostVerifyTaskResult } from './postVerifyTaskCheckpoint'
import { normalizePaperChallengerCandidate, normalizePaperChallengerDailyMetrics, normalizePromotionAuditEvent } from './paperActiveChallenger'

const sha = async (value:unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))),v=>v.toString(16).padStart(2,'0')).join('')
const queueTasks=new Set(['s12-replay-backfill','meta-learning-shadow','ga-shadow-daily','strategy-learning'])
const routes:Record<string,string>={
  'model-ic-rolling':'/model_pool/compute_weekly_ic',
  'artifact-auto-promotion':'/model_pool/artifact_registry/auto_promote',
  'paper-active-postmarket':'/paper_challenger/postmarket_report',
  'obsidian-sync':'/obsidian/daily',
}
const reportReadback=async(env:Bindings,date:string)=>databaseForDataDomain(env,'core').prepare(`
  SELECT date,report_type,market_summary,ml_overview,buy_details,sell_alerts,recommendations,performance,theme_flow
    FROM stock_analysis_reports WHERE date=? AND report_type='daily'`).bind(date).first()

const candidateColumns=`candidate_id AS candidateId,candidate_type AS candidateType,current_state AS currentState,source,
  feature_set_version AS featureSetVersion,promotion_packet_json AS promotionPacketJson,notes`
const metricColumns=`trade_date AS tradeDate,candidate_id AS candidateId,paper_decision_count AS paperDecisionCount,
  precision_at_k AS precisionAtK,hit_rate AS hitRate,avg_return_pct AS avgReturnPct,max_drawdown_pct AS maxDrawdownPct,
  turnover_ratio AS turnoverRatio,topk_overlap AS topkOverlap,regime_split_passed AS regimeSplitPassed,
  runtime_speedup_pct AS runtimeSpeedupPct,metrics_json AS metricsJson`
const auditColumns=`candidate_id AS candidateId,from_state AS fromState,to_state AS toState,decision,
  failed_gates_json AS failedGatesJson,packet_json AS packetJson,real_trading_effect AS realTradingEffect`
const records=(value:any):Record<string,any>[]=>Array.isArray(value)?value.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)):[]
async function paperRows(env:Bindings,proof:any){
  if(!Array.isArray(proof.candidateIds)||!Array.isArray(proof.metricIds)||!Array.isArray(proof.auditIds)
    ||[proof.candidateIds,proof.metricIds,proof.auditIds].some(ids=>ids.length>128))throw new Error('post_verify_paper_proof_budget_invalid')
  const read=async(table:string,columns:string,key:string,ids:any[],dateFilter=false)=>{
    const rows:any[]=[]
    for(let offset=0;offset<ids.length;offset+=64){
      const page=ids.slice(offset,offset+64)
      const result=await databaseForTable(env,table).prepare(`SELECT ${columns} FROM ${table}
        WHERE ${dateFilter?'trade_date=? AND ':''}${key} IN (${page.map(()=>'?')}) ORDER BY ${key}`)
        .bind(...(dateFilter?[proof.tradeDate,...page]:page)).all<any>()
      if(result.success===false||!Array.isArray(result.results))throw new Error('post_verify_owner_readback_failed')
      rows.push(...result.results)
    }
    return key==='candidate_id'?rows.sort((a,b)=>a.candidateId.localeCompare(b.candidateId)):rows
  }
  const candidates=await read('paper_challenger_candidates',candidateColumns,'candidate_id',proof.candidateIds)
  const metrics=await read('paper_challenger_daily_metrics',metricColumns,'candidate_id',proof.metricIds,true)
  const audits=await read('promotion_audit_events',auditColumns,'id',[...proof.auditIds].sort((a,b)=>a-b))
  return {candidates,metrics,audits}
}
async function capturePaper(env:Bindings,date:string){
  const report=postVerifyControllerResponse(env,routes['paper-active-postmarket']) as any
  if(!report||typeof report.generated_at!=='string'||report.generated_at.slice(0,10)!==date
    ||(report.real_trading_effect!=null&&report.real_trading_effect!=='none'))throw new Error('post_verify_paper_report_date_or_scope_invalid')
  const packets=records(report.promotion_packets),events=records(report.audit_events)
  const candidates=packets.map(packet=>normalizePaperChallengerCandidate({candidateId:String(packet.candidate_id??'unknown'),
    candidateType:String(packet.candidate_type??'unknown'),currentState:String(packet.next_state??packet.current_state??'paper_active_challenger'),
    source:'paper_challenger_postmarket_report',promotionPacket:packet,notes:`postmarket_decision:${String(packet.decision??'unknown')}`}))
    .sort((a,b)=>a.candidateId.localeCompare(b.candidateId))
  const metrics=packets.filter(packet=>packet.challenger_metrics&&Object.keys(packet.challenger_metrics).length).map(packet=>{
    const m=packet.challenger_metrics
    return normalizePaperChallengerDailyMetrics({tradeDate:date,candidateId:String(packet.candidate_id??'unknown'),
      paperDecisionCount:typeof m.paper_decision_count==='number'?m.paper_decision_count:0,precisionAtK:m.precision_at_k,
      hitRate:m.hit_rate,avgReturnPct:m.avg_return_pct,maxDrawdownPct:m.max_drawdown_pct,turnoverRatio:m.turnover_ratio,
      topkOverlap:m.topk_overlap,regimeSplitPassed:m.regime_split_passed===true,runtimeSpeedupPct:m.runtime_speedup_pct,metrics:m})
  }).sort((a,b)=>a.candidateId.localeCompare(b.candidateId))
  const expectedAudits=events.map(event=>normalizePromotionAuditEvent({candidateId:String(event.candidate_id??'unknown'),
    fromState:event.from_state==null?null:String(event.from_state),toState:event.to_state==null?null:String(event.to_state),
    decision:String(event.decision??'unknown'),failedGates:Array.isArray(event.failed_gates)?event.failed_gates.map(String):[],
    packet:event.packet&&Object.keys(event.packet).length?event.packet:event,realTradingEffect:String(event.real_trading_effect??'none')}))
  if(candidates.length>128||metrics.length>128||expectedAudits.length>128)throw new Error('post_verify_paper_report_budget_exceeded')
  const proof:any={tradeDate:date,candidateIds:candidates.map(row=>row.candidateId),metricIds:metrics.map(row=>row.candidateId),auditIds:[]}
  if(expectedAudits.length){
    const ids=[...new Set(expectedAudits.map(row=>row.candidateId))]
    const available:any[]=[]
    for(let offset=0;offset<ids.length;offset+=64){
      const page=ids.slice(offset,offset+64)
      const actual=await databaseForTable(env,'promotion_audit_events').prepare(`SELECT id,${auditColumns} FROM promotion_audit_events
        WHERE candidate_id IN (${page.map(()=>'?')}) ORDER BY id DESC LIMIT 512`).bind(...page).all<any>()
      if(actual.success===false||!Array.isArray(actual.results))throw new Error('post_verify_owner_readback_failed')
      available.push(...actual.results)
    }
    for(const expected of expectedAudits){
      const at=available.findIndex(({id,...row})=>JSON.stringify(row)===JSON.stringify(expected))
      if(at<0)throw new Error('post_verify_paper_audit_readback_missing')
      proof.auditIds.push(available.splice(at,1)[0].id)
    }
    proof.auditIds.sort((a:number,b:number)=>a-b)
  }
  const actual=await paperRows(env,proof)
  if(JSON.stringify(actual.candidates)!==JSON.stringify(candidates)||JSON.stringify(actual.metrics)!==JSON.stringify(metrics))
    throw new Error('post_verify_paper_artifact_readback_mismatch')
  return {...proof,checksum:await sha(actual),candidateCount:candidates.length,metricCount:metrics.length,auditCount:expectedAudits.length}
}

export async function capturePostVerifyOwnerEvidence(env:Bindings,task:string,date:string,result:PostVerifyTaskResult) {
  if(result.status==='skipped') return {schema:'post-verify-no-effect-decision-v1',task,date,summary_sha256:await sha(result.summary)}
  const acks=await postVerifyOwnerAckEvidence(env) as any
  const owners=acks.owners as Array<any>
  if(queueTasks.has(task)) {
    if(!owners.some(row=>row.kind==='queue'&&row.owner?.enqueue_acknowledged===true)) throw new Error(`post_verify_owner_queue_ack_missing:${task}`)
    // This proves enqueue only. The task's result keeps 'triggered'; required
    // child/root owning closures must still verify their actual artifacts.
    return {schema:'post-verify-enqueue-ack-v1',task,date,acks}
  }
  if(routes[task]) {
    if(!owners.some(row=>row.kind==='controller'&&row.operation===routes[task]&&row.owner?.owner_contract_verified===true))
      throw new Error(`post_verify_owner_response_contract_unverified:${task}`)
    const paper=task==='paper-active-postmarket'?await capturePaper(env,date):undefined
    return {schema:'post-verify-owner-operation-ack-v1',task,date,acks,paper}
  }
  if(task==='paper-intraday-cache-clear') {
    // A completed delete is a historical operation, not a promise that nobody
    // may populate a fresh cache later. Preserve exact delete acknowledgements.
    const counts=result.summary.match(/intraday_price_cache_cleared=(\d+)\/(\d+)(?:\s+failed=(\d+))?/)
    const deletes=owners.filter(row=>row.kind==='storage'&&row.operation==='delete').reduce((n,row)=>n+Number(row.owner?.ack_count??0),0)
    if(!counts||Number(counts[1])!==Number(counts[2])||Number(counts[3]??0)!==0||deletes!==Number(counts[1]))
      throw new Error('post_verify_cache_invalidation_incomplete')
    return {schema:'post-verify-owner-operation-ack-v1',task,date,acks,cleared:deletes,expected:Number(counts[2])}
  }
  if(task==='daily-report') {
    if(!owners.some(row=>row.kind==='d1'&&row.owner?.table==='stock_analysis_reports'&&row.owner?.successful===true))
      throw new Error('post_verify_daily_report_persistence_ack_missing')
    if(!owners.some(row=>row.kind==='delivery'&&(row.owner?.delivery_acknowledged===true||row.owner?.delivery_not_configured===true)))
      throw new Error('post_verify_daily_report_delivery_unacknowledged')
    const report=await reportReadback(env,date)
    if(!report)throw new Error('post_verify_daily_report_readback_missing')
    return {schema:'post-verify-daily-report-evidence-v1',task,date,acks,report_sha256:await sha(report)}
  }
  throw new Error(`post_verify_owner_evidence_adapter_missing:${task}`)
}

export async function verifyPostVerifyOwnerEvidence(env:Bindings,task:string,date:string,result:PostVerifyTaskResult):Promise<boolean>{
  const proof=result.evidence as any
  if(!proof||proof.task!==task||proof.date!==date)return false
  if(proof.schema==='post-verify-no-effect-decision-v1')return result.status==='skipped'&&proof.summary_sha256===await sha(result.summary)
  if(!proof.acks||!Array.isArray(proof.acks.owners)||!Array.isArray(proof.acks.operations)
    ||!Number.isInteger(proof.acks.ack_count)||!/^[a-f0-9]{64}$/.test(proof.acks.ack_chain_sha256??''))return false
  const owners=proof.acks.owners as Array<any>
  if(queueTasks.has(task)) return proof.schema==='post-verify-enqueue-ack-v1'
    && owners.some(row=>row.kind==='queue'&&row.owner?.enqueue_acknowledged===true)
  if(routes[task]) return proof.schema==='post-verify-owner-operation-ack-v1'
    && owners.some(row=>row.kind==='controller'&&row.operation===routes[task]&&row.owner?.owner_contract_verified===true)
    && (task!=='paper-active-postmarket'||proof.paper?.checksum===await sha(await paperRows(env,proof.paper)))
  if(task==='paper-intraday-cache-clear')return proof.schema==='post-verify-owner-operation-ack-v1'
    && Number.isSafeInteger(proof.cleared)&&proof.cleared===proof.expected
    && owners.filter(row=>row.kind==='storage'&&row.operation==='delete').reduce((n,row)=>n+Number(row.owner?.ack_count??0),0)===proof.cleared
  if(task==='daily-report')return proof.schema==='post-verify-daily-report-evidence-v1'
    && owners.some(row=>row.kind==='delivery'&&(row.owner?.delivery_acknowledged===true||row.owner?.delivery_not_configured===true))
    && proof.report_sha256===await sha(await reportReadback(env,date))
  return false
}
