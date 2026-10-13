import assert from 'node:assert/strict'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'

async function check(change?: string) {
  const checksum = 'a'.repeat(64)
  const admission: any = {approved:true, scope:'paper', business_date:'2026-10-08', configuration:{
    native_execution_policy:{variables:{PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',
      LIVE_EXECUTION_CLIENT_ENABLED:'0', LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'0'}},
    trading_config:{l4Distribution:{artifact:{model_checksum:checksum}}}}}
  const trading: any = {l4Distribution:{scope:'paper',artifact:{model_checksum:checksum}}}
  if(change==='approval')admission.approved=false
  if(change==='scope')admission.scope='live'
  if(change==='admission-date')admission.business_date='2026-10-12'
  if(change==='owner')admission.configuration.native_execution_policy.variables.PAPER_DAILY_PLAN_OWNER='other'
  if(change==='live-client')admission.configuration.native_execution_policy.variables.LIVE_EXECUTION_CLIENT_ENABLED='1'
  if(change==='live-submit')admission.configuration.native_execution_policy.variables.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED='1'
  if(change==='distribution-scope')trading.l4Distribution.scope='live'
  if(change==='checksum')trading.l4Distribution.artifact.model_checksum='b'.repeat(64)
  const db = {prepare:()=>({bind:()=>({first:async()=>({next_session_date:change==='calendar'?'2026-10-14':'2026-10-13'})})})} as any
  const kv = {get:async(key:string)=>key==='ml:active8:paper_admission:v1'?admission:key==='trading:config'?trading:null} as any
  const result=await historicalLearningLineageDecision(db,kv,change==='task'?'evening-chain':'pipeline',
    change==='signal'?'2026-10-09':'2026-10-12',Date.parse(change==='day'?'2026-10-14T09:01:00+08:00':'2026-10-13T23:59:59+08:00'))
  // A future calendar remains allowed by the existing preopen rule, never by this exception.
  if(change==='calendar')assert.notEqual(result.reason,'authorized_paper_recovery_20261013')
  else assert.equal(result.allowed,!change,change)
  if(!change){assert.equal(result.scope,'paper');assert.equal(result.reason,'authorized_paper_recovery_20261013')}
}
void(async()=>{
  for(const change of [undefined,'approval','scope','admission-date','owner','live-client','live-submit',
    'distribution-scope','checksum','calendar','task','signal','day'])await check(change)
  console.log('Oct13 paper boundary: positive and 12 negative cases passed')
})().catch(error=>{console.error(error);process.exitCode=1})
