import assert from 'node:assert/strict'
import test from 'node:test'
import {historicalLearningLineageDecision} from './historicalLearningLineageGuard'

test('10/15 chain recovery remains Paper-bound on 10/16 and expires the next day',async()=>{
 const checksum='a'.repeat(64)
 for(const change of [null,'day','signal','calendar','approved','scope','owner','live','checksum'] as const){
  const signal=change==='signal'?'2026-10-14':'2026-10-15'
  const session=change==='calendar'?'2026-10-19':'2026-10-16'
  const today=change==='day'?'2026-10-17':'2026-10-16'
  const admission={approved:change!=='approved',scope:change==='scope'?'live':'paper',business_date:'2026-10-08',
   configuration:{native_execution_policy:{variables:{PAPER_DAILY_PLAN_OWNER:change==='owner'?'other':'premarket_once_v1',
    LIVE_EXECUTION_CLIENT_ENABLED:change==='live'?'1':'0',LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'0'}},
    trading_config:{l4Distribution:{artifact:{model_checksum:checksum}}}}}
  const trading={l4Distribution:{scope:'paper',artifact:{model_checksum:change==='checksum'?'b'.repeat(64):checksum}}}
  const db={prepare:()=>({bind:()=>({first:async()=>({next_session_date:session})})})} as any
  const kv={get:async(key:string)=>key==='ml:active8:paper_admission:v1'?admission:key==='trading:config'?trading:null} as any
  for(const task of ['evening-chain','screener-v2','pipeline','recommendation']){
   const result=await historicalLearningLineageDecision(db,kv,task,signal,Date.parse(today+'T23:59:59+08:00'))
   assert.equal(result.allowed,change===null || change==='calendar',`${task}:${change}`)
   if(change===null){assert.equal(result.scope,'paper');assert.equal(result.reason,'authorized_paper_recovery_20261016')}
   if(change==='calendar')assert.equal(result.reason,'pre_next_session_open_historical_write_window')
  }
 }
})
