import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runRegimeCompute } from './controllerDailyWorkflows'
import { buildMarketRegimeState, MARKET_REGIME_STATE_KEY } from './marketRegimeState'
import { withPaperExecutionScope } from './paperExecutionScope'
import type { Bindings } from '../types'

async function run(mode: 'new_model' | 'cached' | 'pending') {
  const now = Date.parse('2026-10-19T12:00:00Z')
  const provenance = (generation: string) => ({input_checksum:'b'.repeat(64),risk_quality_checksum:'c'.repeat(64),
    inference_as_of:'2026-10-19T12:00:00Z',model:{sha256:generation.repeat(64),generation,
      trained_at:'2026-10-18T00:00:00Z'}})
  const state = (generation: string) => buildMarketRegimeState({label:'sideways',runDate:'2026-10-19',
    computedAt:'2026-10-19T12:00:00Z',source:'hmm',params:{regime_surface:{bull_market:.1,volatile:.1,sideways:.7,bear_market:.1},
      regime_evidence:{hmm_provenance:provenance(generation)}}})
  const old = state(mode === 'cached' ? '2' : '1')
  const store = new Map<string, string>([[MARKET_REGIME_STATE_KEY,JSON.stringify(old)],
    ['market:twse_holiday_schedule:v2:2026',JSON.stringify({schemaVersion:'twse-holiday-schedule-v2',dates:['2026-10-20']})]])
  let writes = 0, computes = 0, checks = 0
  const kv = {get:async (key:string,type?:string) => {
    const raw=store.get(key);return raw == null ? null : type === 'json' ? JSON.parse(raw) : raw
  },put:async (key:string,value:string)=>{writes++;store.set(key,value)}}
  const raw=JSON.stringify(old)
  const db={prepare:()=>({bind:()=>({first:async()=>({state_json:raw,
    state_checksum:createHash('sha256').update(raw).digest('hex')})})})}
  const env={KV:kv,DB:db,MARKET_DB:db,ML_CONTROLLER_URL:'https://controller.test',
    MULTI_D1_ACTIVE_DOMAINS:'market',MULTI_D1_STRICT:'true'} as unknown as Bindings
  const execute=()=>runRegimeCompute(env,'2026-10-19')
  const scope=()=>withPaperExecutionScope({environment:env,accountId:1,nowMs:now,databases:{market:db as any},
    fetchFrozen:async (url,init)=>{
      const body=JSON.parse(String(init?.body))
      if(String(url).endsWith('/regime/preflight')) {
        checks++
        assert.equal(body.required_until,'2026-10-21T13:30:00+08:00')
        return Response.json({ready:mode!=='pending',run_date:'2026-10-19',model:provenance('2').model,
          input_checksum:'b'.repeat(64),risk_quality_checksum:'c'.repeat(64),maintenance:'running'})
      }
      assert(String(url).endsWith('/regime/compute'))
      assert.equal(body.live,true)
      computes++
      store.set(MARKET_REGIME_STATE_KEY,JSON.stringify(state('2')))
      return Response.json({kv_push_ok:true,run_date:'2026-10-19',regime_surface:state('2').regime_surface})
    }},execute)
  if(mode==='pending') await assert.rejects(scope,/HMM_MODEL_UPDATE_REQUIRED:running/)
  else {
    const result=await scope()
    assert.match(result.result,/kv=verified/)
  }
  assert.equal(checks,1)
  assert.equal(computes,mode==='new_model'?1:0)
  assert.equal(writes,0,'Rejected history must never be restored over current KV')
}

test('new HMM invalidates same-date cache and immutable history before inference',()=>run('new_model'))
test('matching model and certified input reuse inference without recomputation',()=>run('cached'))
test('expired model stops before inference while bounded maintenance runs',()=>run('pending'))
