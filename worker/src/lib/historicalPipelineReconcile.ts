/** Reserve the existing canonical owner for a receipt-only reconciliation. */
import type {Bindings} from '../types'
import {databaseForDataDomain} from './dataDomainRegistry'
import {afterClosePaperRecovery} from './afterClosePaperRecovery'
import {historicalAtomicFailureOnly,verifyStoredFormalServing} from './premarketServingClosure'
import {readL4PortfolioPlan} from './l4PortfolioPlan'
import {reservePipelineExecutionDispatch,commitPipelineExecutionDispatch} from './pipelineStageLease'
import {controllerJson} from './controllerClient'
import type {PremarketPayload} from './premarketEventChain'
import {paperExecutionNow} from './paperExecutionScope'

const defaults={readL4PortfolioPlan,verifyStoredFormalServing,now:()=>paperExecutionNow(),
  dispatch:(env:Bindings,input:PremarketPayload)=>controllerJson<{status:string;execution_name?:string}>(env,
    '/pipeline/v2/premarket-terminal-reconcile',{method:'POST',jsonBody:{receipt:input.l3_receipt,context:input.morning_context}})}

export async function reconcileHistoricalPipeline(env:Bindings,input:PremarketPayload,overrides:Partial<typeof defaults>={}) {
  const deps={...defaults,...overrides},date='2026-10-16'
  if(!afterClosePaperRecovery(env,date,input,deps.now()))throw new Error('historical_pipeline_reconcile_scope_invalid')
  const receipt=input.l3_receipt as {run_id:string;run_date:string}
  if(receipt?.run_date!=='2026-10-15')throw new Error('historical_pipeline_reconcile_signal_invalid')
  const db=databaseForDataDomain(env,'ops')
  const stage=await db.prepare("SELECT status,last_error FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution' AND canonical_run_id=?")
    .bind(receipt.run_date,receipt.run_id).first<{status:string;last_error:string}>()
  if(stage?.status!=='error'||!historicalAtomicFailureOnly(stage.last_error))throw new Error('historical_pipeline_reconcile_owner_changed')
  const plan=await deps.readL4PortfolioPlan(env)
  if(!plan)throw new Error('historical_pipeline_reconcile_plan_missing')
  await deps.verifyStoredFormalServing(env,{runId:receipt.run_id,signalDate:receipt.run_date,error:stage.last_error,plan,historicalRecoveryTradeDate:date})
  const reserved=await reservePipelineExecutionDispatch(db,{businessDate:receipt.run_date,attemptId:receipt.run_id,expectedFailedRunId:receipt.run_id})
  if(!reserved)throw new Error('historical_pipeline_reconcile_reservation_conflict')
  // An unknown HTTP outcome keeps the reservation. It cannot authorize a
  // second job; Controller's own immutable claim must be reconciled first.
  const dispatched=await deps.dispatch(env,input)
  if(dispatched.status!=='dispatched'||!dispatched.execution_name)throw new Error('historical_pipeline_reconcile_dispatch_requires_reconciliation')
  const committed=await commitPipelineExecutionDispatch(db,{businessDate:receipt.run_date,attemptId:receipt.run_id,
    runId:receipt.run_id,executionName:dispatched.execution_name})
  if(!committed)throw new Error('historical_pipeline_reconcile_commit_requires_reconciliation')
  return {status:'dispatched',canonical_run_id:receipt.run_id,execution_name:dispatched.execution_name,
    previous_error:stage.last_error,scope:'completed_phase_receipts_only',nav_credit:0}
}
