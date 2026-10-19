import assert from 'node:assert/strict'
import { HMM_MAX_AGE_MS, hmmLineage, reusableHmmState, sameHmmLineage } from './hmmLifecycle'
import { buildMarketRegimeState } from './marketRegimeState'

const now = Date.parse('2026-10-19T06:00:00Z')
const provenance = {input_checksum:'b'.repeat(64), risk_quality_checksum:'c'.repeat(64),
  inference_as_of:'2026-10-19T05:00:00Z', model:{sha256:'a'.repeat(64), generation:'1',
    trained_at:new Date(now-HMM_MAX_AGE_MS).toISOString()}}
const state = buildMarketRegimeState({label:'sideways',runDate:'2026-10-16',computedAt:'2026-10-19T05:01:00Z',
  params:{regime_evidence:{hmm_provenance:provenance}}})
const preflight = {ready:true,run_date:'2026-10-16',model:provenance.model,
  input_checksum:provenance.input_checksum,risk_quality_checksum:provenance.risk_quality_checksum}
assert.equal(reusableHmmState(state,preflight,now),true)
assert.equal(reusableHmmState(state,preflight,now+1),false)
for (const patch of [{model:{...provenance.model,generation:'2'}}, {input_checksum:'d'.repeat(64)},
  {risk_quality_checksum:'d'.repeat(64)}, {ready:false}, {run_date:'2026-10-15'}]) {
  assert.equal(reusableHmmState(state,{...preflight,...patch},now),false)
}
assert.equal(sameHmmLineage(hmmLineage(state),hmmLineage(structuredClone(state))),true)
assert.equal(sameHmmLineage(null,null),false)
assert.equal(sameHmmLineage({modelSha256:'',modelGeneration:'',inputChecksum:'',qualityChecksum:''},
  {modelSha256:'',modelGeneration:'',inputChecksum:'',qualityChecksum:''}),false)
console.log('HMM exact age, cache version, checksum and decision lineage tests passed')
