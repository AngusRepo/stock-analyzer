import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import { queuePostPipelineStage } from './pipelineStageLease'
import { paperExecutionNow } from './paperExecutionScope'

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
  return `${result.status}; research_jobs=${result.results.length}; research_completion=awaiting_callback`
}
