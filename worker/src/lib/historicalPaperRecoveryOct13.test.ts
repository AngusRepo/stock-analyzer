import assert from 'node:assert/strict'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'

async function check(tradeDate: string, signalDate: string, change?: string) {
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
  const nextDay=new Date(Date.parse(tradeDate+'T12:00:00+08:00')+86400_000).toISOString().slice(0,10)
  const db = {prepare:()=>({bind:()=>({first:async()=>({next_session_date:change==='calendar'?nextDay:tradeDate})})})} as any
  const kv = {get:async(key:string)=>key==='ml:active8:paper_admission:v1'?admission:key==='trading:config'?trading:null} as any
  const result=await historicalLearningLineageDecision(db,kv,change==='task'?'evening-chain':'pipeline',
    change==='signal'?'2026-10-09':signalDate,Date.parse((change==='day'?nextDay:tradeDate)+'T23:59:59+08:00'))
  // A future calendar remains allowed by the existing preopen rule, never by this exception.
  if(change==='calendar')assert.notEqual(result.reason,'authorized_paper_recovery_'+tradeDate.replaceAll('-',''))
  else assert.equal(result.allowed,!change,change)
  if(!change){assert.equal(result.scope,'paper');assert.equal(result.reason,'authorized_paper_recovery_'+tradeDate.replaceAll('-',''))}
}
void(async()=>{
  for(const [signal,trade] of [['2026-10-12','2026-10-13'],['2026-10-13','2026-10-14']])
    for(const change of [undefined,'approval','scope','admission-date','owner','live-client','live-submit',
      'distribution-scope','checksum','calendar','task','signal','day'])await check(trade,signal,change)
  console.log('Oct13/14 paper boundaries: 2 positive and 24 negative cases passed')
})().catch(error=>{console.error(error);process.exitCode=1})
