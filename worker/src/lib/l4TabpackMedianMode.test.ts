import assert from 'node:assert/strict'
import test from 'node:test'
import { isSingleBMode, validSingleBModel, SINGLE_B_TABPACK_CORE16_MEDIAN, primaryModelLabel } from './paperStrategyMode'

function policy(): any {
  const sha = 'a'.repeat(64)
  return { operating_mode:SINGLE_B_TABPACK_CORE16_MEDIAN, strategy_role:'B', scope:'paper',
    artifact:{model:{residual_tabpack:{schema_version:'l4-three-head-tabpack-core16-median-v1',
      training_recipe:'three-head-oof-tabpack-official-core16-median-v1',
      aggregation:'median_residual_per_symbol',missing_member_policy:'fail_closed',
      payload_checksum:sha,anchor_model_checksum:sha,training_label_known_max:'2026-10-01',
      members:[42,43,44].map(seed=>({seed,model:{schema_version:'l4-three-head-residual-tabpack-official-v2',
        anchor_model_checksum:sha,payload_checksum:sha,residual_mean:0,residual_scale:1,
        training_label_known_max:'2026-10-01',members:[{member_id:15,step:2,depth:4,weight:1}],
        weights:{sha256:sha,path:`l4_distribution/tabpack_weights/${sha}.npz`,bytes:100},
        provenance:{seed,training_recipe:'three-head-oof-tabpack-official-core16-v1',n_models:16,
          upstream_commit:'05a89e21b955f12de84889d662e15ca534019aaa',
          selection_rule:'official_online_greedy_validation_only',
          checkpoint_sha256:sha,partition_checksum:sha,source_rows_checksum:sha}}}))}}}}
}

test('explicit core16 median mode accepts three complete packs',()=>{
  assert.equal(isSingleBMode(SINGLE_B_TABPACK_CORE16_MEDIAN),true)
  assert.equal(validSingleBModel(policy()),true)
  assert.match(primaryModelLabel(SINGLE_B_TABPACK_CORE16_MEDIAN),/16 × 3 seeds/)
})
for (const fault of ['single','missing','order','seed','recipe','count','upstream','partition','source','anchor','weight','size','member','scale','cutoff','mlp','real']) {
  test(`median admission rejects ${fault}`,()=>{
    const p=policy(),m=p.artifact.model.residual_tabpack,pack=m.members[1].model
    if(fault==='single')p.artifact.model.residual_tabpack=pack
    if(fault==='missing')m.members.pop()
    if(fault==='order')m.members.reverse()
    if(fault==='seed')pack.provenance.seed=42
    if(fault==='recipe')pack.provenance.training_recipe='old'
    if(fault==='count')pack.provenance.n_models=64
    if(fault==='upstream')pack.provenance.upstream_commit='b'.repeat(40)
    if(fault==='partition')pack.provenance.partition_checksum='b'.repeat(64)
    if(fault==='source')pack.provenance.source_rows_checksum='b'.repeat(64)
    if(fault==='anchor')pack.anchor_model_checksum='b'.repeat(64)
    if(fault==='weight')pack.weights.sha256='b'.repeat(64)
    if(fault==='size')pack.weights.bytes=96*1024*1024+1
    if(fault==='member')pack.members[0].member_id=16
    if(fault==='scale')pack.residual_scale=2
    if(fault==='cutoff')pack.training_label_known_max='2026-10-02'
    if(fault==='mlp')p.artifact.model.residual_mlp={}
    if(fault==='real')p.scope='real'
    assert.equal(validSingleBModel(p),false)
  })
}
