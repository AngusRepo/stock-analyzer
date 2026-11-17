import assert from 'node:assert/strict'
import test from 'node:test'
import { isSingleBMode, primaryModelLabel, R33_ROSTER_ISOTONIC, R33_MODEL_SCHEMA, validSingleBModel } from './paperStrategyMode'
import { L4_R33_FEATURE_SCHEMA } from './l4ReleaseEvidence'
const R33_MODELS=['LightGBM','ExtraTrees','TabM','GNN'] as const

function policy(): any {
  return {operating_mode:R33_ROSTER_ISOTONIC,strategy_role:'B',scope:'paper',
    artifact:{feature_schema:L4_R33_FEATURE_SCHEMA,model:{schema_version:R33_MODEL_SCHEMA,
      model_order:[...R33_MODELS],feature_names:[...R33_MODELS.flatMap(m=>[`${m}_z`,`${m}_available`]),'score']}}}
}

test('R33 is one Paper strategy mode with its own structural admission',()=>{
  assert.equal(isSingleBMode(R33_ROSTER_ISOTONIC),true)
  assert.equal(validSingleBModel(policy()),true)
  assert.match(primaryModelLabel(R33_ROSTER_ISOTONIC),/R33/)
})

for (const fault of ['role','scope','residual_mlp','residual_tabpack','model_schema','feature_schema','v3_feature_schema','feature_order','mode_on_old_model','old_mode_on_r33'])
  test(`R33 admission rejects ${fault}`,()=>{
    const p=policy()
    if(fault==='role')p.strategy_role='A'
    if(fault==='scope')p.scope='real'
    if(fault==='residual_mlp')p.artifact.model.residual_mlp={}
    if(fault==='residual_tabpack')p.artifact.model.residual_tabpack={}
    if(fault==='model_schema')p.artifact.model.schema_version='l4-three-head-v1'
    if(fault==='feature_schema')p.artifact.feature_schema='full-l3-30-timexer-signals-v4'
    if(fault==='v3_feature_schema')p.artifact.feature_schema='full-l3-30-all-available-signals-v3'
    if(fault==='feature_order')p.artifact.model.feature_names.reverse()
    if(fault==='mode_on_old_model'){p.artifact={model:{residual_tabpack:{schema_version:'l4-three-head-residual-tabpack-v1'}}}}
    if(fault==='old_mode_on_r33')p.operating_mode='single_b_tabpack_v1'
    assert.equal(validSingleBModel(p),false)
  })
