import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { inferIntradayRescoreCron } from './adminTriggerWorkerDomainTasks'
import { premarketStageNotBefore } from './premarketEventChain'
import { premarketWork } from './premarketEventWork'

test('delayed deliveries retain the original four independent rescore slots',()=>{
 for(const [time,cron] of [['02:00','0 2 * * 1-5'],['03:00','0 3 * * 1-5'],['04:00','0 4 * * 1-5'],['04:30','30 4 * * 1-5']])
   assert.equal(inferIntradayRescoreCron(null,`2026-10-08T${time}:00Z`),cron)
 assert.throws(()=>inferIntradayRescoreCron(null,'invalid'),/schedule_time_invalid/)
 assert.equal(inferIntradayRescoreCron('0 2 * * 1-5','2026-10-08T04:40:00Z'),'0 2 * * 1-5')
})
test('setup queues broker health at 08:30 independently from allocation and debate',async()=>{
 const work=premarketWork({PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any,'2026-10-08',{
  warmup:async()=> 'controller verified',ensurePaperCorporateSource:async()=>{},settle:async()=>{},
  marketHealth:async()=> 'Shioaji:ok',
 })
 const result=await work('setup',{},async()=>{})
 assert.equal(result.next,'allocate');assert.deepEqual(result.followups,['market-health'])
 assert.equal(premarketStageNotBefore('2026-10-08','market-health'),Date.parse('2026-10-08T08:30:00+08:00'))
 assert.equal((await work('market-health',result.receipt,async()=>{})).next,null)
 const failed=premarketWork({PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any,'2026-10-08',{marketHealth:async()=> 'ERROR: Shioaji:fail(503)'})
 await assert.rejects(failed('market-health',{},async()=>{}),/Shioaji/)
})
test('physical rescore consolidation does not add extra half-hour invocations or retired jobs',()=>{
 const manifest=JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json','utf8'))
 const rows=manifest.jobs.filter((x:any)=>x.task==='intraday-rescore')
 assert.deepEqual(rows.map((x:any)=>x.schedule).sort(),['0 2-4 * * 1-5','30 4 * * 1-5'])
 for(const id of ['paired-native-execution-morning','paired-native-execution-day','data-domain-shadow-backfill-ops','data-domain-shadow-backfill-execution','pre-market-warmup']) assert(!manifest.jobs.some((x:any)=>x.id===id))
})


test('consolidated physical timers keep four logical UI cron slots',async()=>{
 const {SCHEDULER_STATUS_JOB_DEFS}=await import('./schedulerStatus')
 for(const [id,cron] of [['rescore-10','0 2 * * 1-5'],['rescore-11','0 3 * * 1-5'],['rescore-12','0 4 * * 1-5'],['rescore-1230','30 4 * * 1-5']]) assert.equal(SCHEDULER_STATUS_JOB_DEFS.find(x=>x.id===id)?.cron,cron)
})
