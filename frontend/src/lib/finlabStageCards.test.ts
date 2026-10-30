import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SchedulerJob } from './api'
import { finlabStageCards } from './finlabStageCards'
const parent={id:'finlab-v4-backfill',runId:'run',statusRunDate:'2026-10-16',lastStatus:'running',lastDuration:'40m',
  lastRunAt:'2026-10-16T13:00:00Z',lastError:'old error',accounting:{},ticket:{}} as SchedulerJob
test('legacy missing or mismatched receipts never fabricate running children or inherited timing',()=>{
  for(const job of [parent,{...parent,finlabProgress:{run_id:'other',run_date:'2026-10-16',phases:[]} as any}]) {
    const cards=finlabStageCards(job)
    assert.equal(cards.length,3)
    assert(cards.every(c=>c.lastStatus==='waiting' && c.lastDuration==='N/A' && c.lastRunAt===null && !c.lastError))
  }
})
test('sequential cards use own timing and preserve failure without three spinners',()=>{
  const job:SchedulerJob={...parent,finlabProgress:{run_id:'run',run_date:'2026-10-16',dispatch_attempt:1,sequence:3,observed_at:'2026-10-16T14:01:00Z',phases:[
    {phase:'acquire',status:'completed',started_at:'2026-10-16T14:00:00Z',completed_at:'2026-10-16T14:00:30Z',elapsed_ms:30000},
    {phase:'validate',status:'running',started_at:'2026-10-16T14:00:30Z'}]}}
  const cards=finlabStageCards(job,Date.parse('2026-10-16T14:01:00Z'))
  assert.deepEqual(cards.map(c=>c.lastStatus),['success','running','waiting'])
  assert.equal(cards[0].lastDuration,'0 分 30 秒')
  assert.equal(cards[1].lastDuration,'0 分 30 秒（進行中）')
  assert.deepEqual(finlabStageCards({...job,lastStatus:'failed'}).map(c=>c.lastStatus),['success','failed','waiting'])
})
test('FU8-A: FinLab cards match the run the Worker selected, not the ticket runId',()=>{
  const finlabProgress={run_id:'finlab-run',run_date:'2026-10-16',dispatch_attempt:1,sequence:1,observed_at:'2026-10-16T14:01:00Z',phases:[
    {phase:'acquire',status:'completed',started_at:'2026-10-16T14:00:00Z',completed_at:'2026-10-16T14:00:30Z',elapsed_ms:30000}]} as any
  const job:SchedulerJob={...parent,runId:'ticket-1',finlabRunId:'finlab-run',finlabProgress}
  assert.equal(finlabStageCards(job)[0].lastStatus,'success')
  assert(finlabStageCards({...job,finlabRunId:'older-run'}).every(c=>c.lastStatus==='waiting' && c.lastDuration==='N/A'))
  assert(finlabStageCards({...job,finlabRunId:null}).every(c=>c.lastStatus==='waiting'), 'null falls back to the ticket runId')
  assert.equal(finlabStageCards({...job,runId:'finlab-run',finlabRunId:undefined})[0].lastStatus,'success')
  assert(finlabStageCards({...job,statusRunDate:'2026-10-15'}).every(c=>c.lastStatus==='waiting'))
})
