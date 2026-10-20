import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChampionTradingConfig, validateTradingConfig } from './tradingConfig'

function learning() {
  const ref = {path:'l4_distribution/release/test.json',sha256:'a'.repeat(64)}
  return {native_observation: {l3_identity:{artifact_id:'parent',cohort_id:'cohort',payload_checksum:'b'.repeat(64),base_artifact_set_checksum:'c'.repeat(64)},
    serving_context:ref,timesfm_context:ref,training_cutoffs:ref,classification:ref},
    shadow:{bundle:ref,baseline:ref,evaluation_policy:ref,classification:ref},monthly:{classification:ref}}
}
test('merged settings preserve a complete explicit learning configuration',()=>{
  const value=learning(),config=buildChampionTradingConfig({l4R2Learning:value})
  assert.deepEqual(config.l4R2Learning,value)
  assert.deepEqual(validateTradingConfig(config),[])
  assert.equal(buildChampionTradingConfig(null).l4R2Learning,undefined)
})
test('partial setup, mismatched classification and trading activation fail validation',()=>{
  for (const change of [(v:any)=>delete v.shadow,
    (v:any)=>v.shadow.classification={path:'l4_distribution/other.json',sha256:'b'.repeat(64)},
    (v:any)=>v.shadow.automatic_promotion=true,
    (v:any)=>v.native_observation.serving_context={path:'secret.json',sha256:'a'.repeat(64)}]) {
    const value=learning();change(value)
    assert.ok(validateTradingConfig(buildChampionTradingConfig({l4R2Learning:value})).some(s=>s.startsWith('l4R2Learning')))
  }
})

test('retired TimesFM reference is not required by new learning configuration',()=>{
  const value: any=learning()
  delete value.native_observation.timesfm_context
  assert.deepEqual(validateTradingConfig(buildChampionTradingConfig({l4R2Learning:value})),[])
})
