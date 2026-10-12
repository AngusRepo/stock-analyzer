import assert from 'node:assert/strict'
import {historicalLearningLineageDecision} from './historicalLearningLineageGuard'

async function main() {
  const config = {l4Distribution:{scope:'paper',artifact:{model_checksum:'a'.repeat(64)}}}
  const admission:any = {approved:true,scope:'paper',business_date:'2026-10-08',configuration:{
    trading_config:structuredClone(config),native_execution_policy:{variables:{
      PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',LIVE_EXECUTION_CLIENT_ENABLED:'0',LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'0'}}}}
  const db = {prepare:()=>({bind:()=>({first:async()=>({next_session_date:'2026-10-12'})})})} as unknown as D1Database
  const kv = {get:async(key:string)=>key==='trading:config'?config:admission} as unknown as KVNamespace
  const check = (day='2026-10-08',now='2026-10-12T04:00:00Z') => historicalLearningLineageDecision(db,kv,'pipeline',day,Date.parse(now))
  assert.equal((await check()).reason,'authorized_paper_recovery_20261012')
  for(const field of ['LIVE_EXECUTION_CLIENT_ENABLED','LIVE_EXECUTION_SUBMIT_GUARD_ENABLED']) {
    admission.configuration.native_execution_policy.variables[field]='1'
    assert.equal((await check()).allowed,false)
    admission.configuration.native_execution_policy.variables[field]='0'
  }
  admission.approved=false; assert.equal((await check()).allowed,false); admission.approved=true
  config.l4Distribution.artifact.model_checksum='b'.repeat(64)
  assert.equal((await check()).allowed,false)
  config.l4Distribution.artifact.model_checksum='a'.repeat(64)
  assert.equal((await check('2026-10-07')).allowed,false)
  assert.equal((await check('2026-10-08','2026-10-13T04:00:00Z')).allowed,false)
  assert.equal((await check()).scope,'paper')
  console.log('October 12 paper recovery boundaries passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
