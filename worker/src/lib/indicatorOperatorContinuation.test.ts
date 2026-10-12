import assert from 'node:assert/strict'
import { continueCompletedIndicatorFinalizer } from './indicatorQueueRecovery'
const date='2026-10-08', runId=date+'-original', prefix=`cron:indicator-queue:${date}:${runId}`
function fixture() {
  const values = new Map<string,string>([[`scheduler:run:indicator-queue:${date}`,
    JSON.stringify({run_id:runId,summary:'shards=4'})],[`${prefix}:watchdog-recoveries`,'6']])
  for(let i=0;i<4;i++)values.set(`${prefix}:done:${i}`,'1')
  const sent:any[]=[]; let claimed=false, fail=false, lease=false, handoff=false
  const env:any={KV:{async get(k:string,t?:string){const v=values.get(k);return v==null?null:t==='json'?JSON.parse(v):v},
    async put(k:string,v:string){values.set(k,v)}},
    DB:{prepare(sql:string){return {bind(){return {
      async first(){return sql.includes('pipeline_stage_runs') ? (handoff?{canonical_run_id:runId}:null)
        : lease?{expires_at:new Date(Date.now()+60000).toISOString()}:null},
      async run(){if(claimed)return {meta:{changes:0}};claimed=true;return {meta:{changes:1}}},
    }}}}},UPDATE_QUEUE:{async send(body:any){if(fail)throw Error('unknown_delivery');sent.push(body)}}}
  return {env,values,sent,setFail:()=>{fail=true},setLease:()=>{lease=true},setHandoff:()=>{handoff=true}}
}
async function main(){
  const f=fixture()
  const outcomes=await Promise.allSettled([1,2].map(()=>continueCompletedIndicatorFinalizer(f.env,date,runId,6)))
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].runId,runId)
  assert.equal(f.values.get(`${prefix}:watchdog-recoveries`),'6')
  assert.equal(f.values.has(`${prefix}:finalized`),false)
  for(const condition of ['missing','counter','lease','handoff','finalized','run']){
    const x=fixture();let requested=runId
    if(condition==='missing')x.values.delete(`${prefix}:done:3`)
    if(condition==='counter')x.values.set(`${prefix}:watchdog-recoveries`,'7')
    if(condition==='lease')x.setLease()
    if(condition==='handoff')x.setHandoff()
    if(condition==='finalized')x.values.set(`${prefix}:finalized`,'1')
    if(condition==='run')requested='another'
    await assert.rejects(()=>continueCompletedIndicatorFinalizer(x.env,date,requested,6))
    assert.equal(x.sent.length,0)
  }
  const x=fixture();x.setFail()
  await assert.rejects(()=>continueCompletedIndicatorFinalizer(x.env,date,runId,6),/unknown_delivery/)
  await assert.rejects(()=>continueCompletedIndicatorFinalizer(x.env,date,runId,6),/already_claimed/)
  assert.equal(x.values.get(`${prefix}:watchdog-recoveries`),'6')
  console.log('indicatorOperatorContinuation tests passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
