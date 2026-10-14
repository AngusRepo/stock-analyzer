import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strategyNavExecution } from './strategyNavExecution'
import { SINGLE_B_FULL_MLP_MEDIAN } from './paperStrategyMode'
import { buildChampionTradingConfig } from './tradingConfig'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'

function configFixture() {
  const config = buildChampionTradingConfig(null)
  const checksum = 'a'.repeat(64)
  const receipt = { schema_version:'l4-paper-acceptance-v1', feature_schema:L4_FEATURE_SCHEMA,
    model_checksum:checksum, checks:Object.fromEntries(L4_ACCEPTANCE_CHECKS.map(k=>[k,true])),
    acceptance_mode:'paper_experiment', efficacy_status:'unproven',
    experiment_authorization:{scope:'paper', approved:true, source_reference:'SYNTHETIC TEST ONLY', model_checksum:checksum} }
  config.l4Distribution = { scope:'paper', operating_mode:SINGLE_B_FULL_MLP_MEDIAN, strategy_role:'B',
    constraints:{exposure_cap:.8, name_cap:.08, min_weight:0, max_positions:5},
    artifact:{schema_version:'l4-distribution-v1', feature_schema:L4_FEATURE_SCHEMA, model_checksum:checksum,
      l3_identity:{artifact_id:'synthetic', cohort_id:'test', payload_checksum:checksum, base_artifact_set_checksum:checksum},
      release:{scope:'paper', decision:'PASS', model_checksum:checksum, validation_receipt_checksum:checksum,
        validation_receipt:receipt, acceptance_mode:'paper_experiment', efficacy_status:'unproven'},
      model:{residual_mlp:{schema_version:'l4-three-head-residual-mlp-median-v1',
        aggregation:'median_residual_per_symbol', residual_multiplier:1, missing_member_policy:'fail_closed',
        payload_checksum:checksum, anchor_model_checksum:checksum,
        members:[42,43,44].map(seed=>({seed, model:{schema_version:'l4-three-head-residual-mlp-v1',
          inputs:34, width:128, blocks:3, anchor_model_checksum:checksum, payload_checksum:checksum},
          provenance:{seed, checkpoint_sha256:checksum, training_receipt_sha256:checksum, partition_sha256:checksum}}))}}} } as any
  return config
}

test('strategy task calls only its authenticated isolated endpoint and rejects incomplete receipts', async () => {
  const originalFetch = globalThis.fetch
  const env: any = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'test-secret',
    KV: { get: async () => configFixture() } }
  let receipt: any = { status: 'ok', pairs: [{ status: 'collecting' }], production_effect: false, promotion_allowed: false }
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, 'https://controller.invalid/paper/strategy-nav-execution-tick')
    assert.equal(init?.method, 'POST')
    assert.equal((init?.headers as any)['X-Controller-Token'], 'test-secret')
    assert.match(JSON.parse(init!.body as string).session_date, /^\d{4}-\d{2}-\d{2}$/)
    return new Response(JSON.stringify(receipt), { status: 200 })
  }
  try {
    assert.match(await strategyNavExecution(env), /pairs=1/)
    for (const invalid of [
      { ...receipt, status: 'failed' }, { ...receipt, pairs: [{ status: 'failed' }] },
      { ...receipt, promotion_allowed: true }, { ...receipt, production_effect: true },
      { ...receipt, status: 'awaiting_strategy_registration', pairs: [] },
    ]) {
      receipt = invalid
      await assert.rejects(strategyNavExecution(env), /strategy_nav_execution_/)
    }
    assert.equal(calls, 6)
  } finally { globalThis.fetch = originalFetch }
})

test('unsupported formal policy never wakes a comparison producer', async () => {
  await assert.rejects(strategyNavExecution({ KV: { get: async () => ({}) } } as any), /requires_single_b/)
})
