import assert from 'node:assert/strict'
import {test} from 'node:test'
import {matchesInputWork,loadPipelineInputWork} from './pipelineInputWork'
import type {Bindings} from '../types'

const now=Date.parse('2026-10-20T15:51:00Z')
const work=()=>({run_id:'run',run_date:'2026-10-20',phase:'input_snapshot',stage_id:'a'.repeat(64),
  status:'running',active:1,completed:0,total:1,observed_at:new Date(now).toISOString()})
test('child activity must match current run/date/phase, be fresh and include an active worker',()=>{
  const valid=(value:unknown)=>matchesInputWork(value,'run','2026-10-20','input_snapshot',now)
  assert(valid(work()))
  for(const bad of [{run_id:'old'},{run_date:'2026-10-19'},{phase:'input_prep'}, {active:0},
    {observed_at:new Date(now-31_000).toISOString()},{observed_at:new Date(now+6_000).toISOString()},
    {total:129},{active:2},{observed_at:'bad'}]) assert(!valid({...work(),...bad}))
})
test('fresh exact cache avoids any controller call; unrelated cached data is never returned',async()=>{
  const current={...work(),observed_at:new Date().toISOString()}
  const env={KV:{get:async()=>current},ML_CONTROLLER_URL:''} as unknown as Bindings
  assert.strictEqual(await loadPipelineInputWork(env,'run','2026-10-20','input_snapshot'),current)
  assert.equal(await loadPipelineInputWork(env,'other','2026-10-20','input_snapshot'),undefined)
  assert.equal(await loadPipelineInputWork(env,'run','2026-10-20','modal_prediction'),undefined)
})
