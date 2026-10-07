import assert from 'node:assert/strict'
import test from 'node:test'
import { isSingleBMode, validSingleBModel, SINGLE_B_FULL_MLP_MEDIAN, primaryModelLabel } from './paperStrategyMode'

function policy() {
  const checksum = 'a'.repeat(64)
  return { operating_mode:SINGLE_B_FULL_MLP_MEDIAN, strategy_role:'B', scope:'paper',
    artifact:{model:{residual_mlp:{schema_version:'l4-three-head-residual-mlp-median-v1',
      aggregation:'median_residual_per_symbol',residual_multiplier:1,missing_member_policy:'fail_closed',
      payload_checksum:checksum,anchor_model_checksum:checksum,
      members:[42,43,44].map(seed=>({seed,model:{schema_version:'l4-three-head-residual-mlp-v1',
        inputs:34,width:128,blocks:3,anchor_model_checksum:checksum,payload_checksum:checksum},
        provenance:{seed,checkpoint_sha256:checksum,training_receipt_sha256:checksum,partition_sha256:checksum}}))}}}}
}
test('Full median is explicit single B; historical TabPack remains readable',()=>{
  assert.equal(isSingleBMode(SINGLE_B_FULL_MLP_MEDIAN),true)
  assert.equal(isSingleBMode('single_b_tabpack_v1'),true)
  assert.equal(isSingleBMode('unrecognized'),false)
  assert.equal(validSingleBModel(policy()),true)
  assert.match(primaryModelLabel(SINGLE_B_FULL_MLP_MEDIAN),/Full MLP median/)
})
for (const fault of ['half','missing','seed','wrong_schema','two_owners','real','provenance']) test(`Full admission rejects ${fault}`,()=>{
  const p=policy(), m=p.artifact.model.residual_mlp
  if(fault==='half')m.residual_multiplier=.5
  if(fault==='missing')m.members.pop()
  if(fault==='seed')m.members[1].seed=42
  if(fault==='wrong_schema')m.schema_version='l4-three-head-residual-mlp-v1'
  if(fault==='two_owners')(p.artifact.model as any).residual_tabpack={}
  if(fault==='real')p.scope='real'
  if(fault==='provenance')m.members[1].provenance.checkpoint_sha256=''
  assert.equal(validSingleBModel(p),false)
})
