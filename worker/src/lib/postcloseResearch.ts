import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import { queuePostPipelineStage } from './pipelineStageLease'
import { paperExecutionNow } from './paperExecutionScope'
import { databaseForDataDomain } from './dataDomainRegistry'

/** A serving callback closes publication, not the after-close research chain. */
export async function verifyServingOnlyCallback(env: Bindings, day: string, runId: string, checksum: unknown) {
  if (env.PAPER_DAILY_PLAN_OWNER !== 'premarket_once_v1' || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum))
    throw new Error('premarket_serving_callback_invalid')
  const result=await controllerJson<{publication?: {checksum: string; signal_date: string; run_id: string}}>(
    env,'/pipeline/v2/premarket-state?'+new URLSearchParams({date:day,run_id:runId}))
  if (!result.publication || result.publication.checksum!==checksum || result.publication.signal_date!==day || result.publication.run_id!==runId)
    throw new Error('premarket_serving_callback_receipt_mismatch')
}

type Dispatch = {status: string; run_id?: string; run_date?: string; reason?: string; observed_state?: string}
/** 14:20 scheduler task: dispatch sealed morning research, then queue the existing post-pipeline owner. */
export async function runPostcloseResearch(env: Bindings, tradeDate: string) {
  if (env.PAPER_DAILY_PLAN_OWNER !== 'premarket_once_v1') return 'SKIP: premarket owner disabled'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || paperExecutionNow()<Date.parse(tradeDate+'T13:30:00+08:00'))
    throw new Error('postclose_research_before_close')
  const result=await controllerJson<{trade_date: string; status: string; results: Dispatch[]}>(env,'/pipeline/v2/premarket-postclose',
    {method:'POST',jsonBody:{trade_date:tradeDate}})
  if (result.trade_date!==tradeDate || !Array.isArray(result.results)) throw new Error('postclose_dispatch_receipt_invalid')
  const errors: string[]=[]
  for (const item of result.results) {
    if (item.status!=='dispatched' || !item.run_date || !item.run_id) {
      errors.push(item.reason??item.status);continue
    }
    // Reuse the original post-pipeline owner; no second verification workflow.
    try {
      const queued=await queuePostPipelineStage(env,{businessDate:item.run_date,runId:item.run_id,
        authority:{stage:'pipeline_execution',canonicalRunId:item.run_id,status:'success'}})
      if (queued.canonicalRunId!==item.run_id) throw new Error('postclose_canonical_owner_conflict')
    } catch(error) {errors.push(error instanceof Error?error.message:String(error))}
  }
  if (errors.length || ['error','reconciliation_required'].includes(result.status))
    throw new Error('postclose_dispatch_incomplete:'+errors.join(';'))
  if (result.status==='no_published_work') return `${result.status}; research_jobs=0; ${await verifyNoPublicationForTradeDate(env,tradeDate)}`
  return `${result.status}; research_jobs=${result.results.length}; research_completion=awaiting_callback`
}

/** NEW-35: "no work" is only a success when this trade date has no published plan; an unverifiable state fails loud. */
async function verifyNoPublicationForTradeDate(env: Bindings, tradeDate: string): Promise<string> {
  const stage=await databaseForDataDomain(env,'ops').prepare(
    "SELECT business_date, canonical_run_id FROM pipeline_stage_runs WHERE stage='pipeline_execution' AND business_date<? ORDER BY business_date DESC LIMIT 1")
    .bind(tradeDate).first<{business_date: string; canonical_run_id: string}>()
  if (!stage?.business_date) return 'publication_check=no_prior_pipeline_execution'
  // A prior execution row without its run id cannot be checked: fail loudly rather than assume none.
  if (!stage.canonical_run_id) throw new Error(`postclose_publication_state_unverifiable:${stage.business_date}:canonical_run_id_missing`)
  let state: {publication?: {trade_date?: string} | null}
  try {
    state=await controllerJson(env,'/pipeline/v2/premarket-state?'+new URLSearchParams({date:stage.business_date,run_id:stage.canonical_run_id}))
  } catch(error) {
    throw new Error(`postclose_publication_state_unverifiable:${stage.canonical_run_id}:${error instanceof Error?error.message:String(error)}`)
  }
  if (state?.publication?.trade_date===tradeDate) throw new Error('postclose_work_missing_for_publication:'+stage.canonical_run_id)
  return `publication_check=none_for_trade_date signal_run=${stage.canonical_run_id}`
}
