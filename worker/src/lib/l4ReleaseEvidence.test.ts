import test from 'node:test'
import { R33_EQUAL7_ISOTONIC as L4_R33_OPERATING_MODE, l4OperatingModeError } from './paperStrategyMode'
import assert from 'node:assert/strict'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS, L4_R33_FEATURE_SCHEMA, R33_MODELS,
  l4ReleaseEvidenceError, validL4FeatureSchema } from './l4ReleaseEvidence'

function fixture() {
  const model='b'.repeat(64), hash='a'.repeat(64)
  const shared=Object.fromEntries(['pool_checksum','calendar_checksum','initial_account_checksum','costs_checksum',
    'risk_constraints_checksum','market_data_checksum','allocator_checksum','opb_protocol_checksum','execution_checksum'].map(k=>[k,hash]))
  const runs:any={}, metrics:any={}
  for (const [role,nav] of [['candidate',102],['incumbent',101],['l3_same_allocator',101.5]] as const) {
    runs[role]={...shared,complete:true,model_checksum:model,l3_identity_checksum:hash,
      prediction_policy:role==='l3_same_allocator'?'native_l3_mean_no_correction':role,
      ledger_checksum:hash,accounting:'cash_plus_marked_holdings_after_costs',external_cash_flows:'none',initial_nav:100,
      daily_nav:[{date:'2026-08-20',nav,cash:nav/2,holdings_market_value:nav/2}]}
    metrics[role]={net_return:nav/100-1,max_drawdown:0}
  }
  const comparison:any={schema_version:'l4-paired-incremental-comparison-v2',complete:true,passes:true,
    candidate_model_checksum:model,l3_identity_checksum:hash,runs,metrics,
    protocol:{scope:'paired_native_paper_execution',holdout_usage:'untouched_after_selection',preselection:false,
      selection_frozen_before:'2026-08-19',signal_dates:['2026-08-20'],max_allowed_drawdown:.1}}
  const receipt:any={schema_version:'l4-paper-acceptance-v1',feature_schema:L4_FEATURE_SCHEMA,checks:Object.fromEntries(L4_ACCEPTANCE_CHECKS.map(key=>[key,true])),model_checksum:model,
    acceptance_mode:'comparative_promotion',paired_account_comparison:comparison}
  return {feature_schema:L4_FEATURE_SCHEMA,model_checksum:model,training_label_known_max:'2026-08-19',release:{scope:'paper',decision:'PASS',model_checksum:model,
    acceptance_mode:'comparative_promotion',validation_receipt_checksum:hash,validation_receipt:receipt}}
}

test('Worker recomputes NAV and rejects L4 wins vs incumbent but loses to L3',()=>{
  const a=fixture();assert.equal(l4ReleaseEvidenceError(a),null)
  const c=a.release.validation_receipt.paired_account_comparison
  c.runs.l3_same_allocator.daily_nav[0]={date:'2026-08-20',nav:103,cash:51.5,holdings_market_value:51.5}
  c.metrics.l3_same_allocator.net_return=.03
  assert.equal(l4ReleaseEvidenceError(a),'l4_release_no_incremental_benefit')
})

test('Worker rejects old two-policy evidence and reused holdout',()=>{
  const a=fixture();a.release.validation_receipt.paired_account_comparison.schema_version='old'
  assert.equal(l4ReleaseEvidenceError(a),'l4_release_incremental_comparison_missing')
  const b=fixture();b.release.validation_receipt.paired_account_comparison.protocol.holdout_usage='reused_diagnostic'
  assert.equal(l4ReleaseEvidenceError(b),'l4_release_incremental_comparison_missing')
})

test('Worker rejects unmatched allocator and fraudulent reported metrics',()=>{
  const a=fixture();a.release.validation_receipt.paired_account_comparison.runs.l3_same_allocator.allocator_checksum='c'.repeat(64)
  assert.equal(l4ReleaseEvidenceError(a),'l4_release_native_l3_comparison_mismatch')
  const b=fixture();b.release.validation_receipt.paired_account_comparison.metrics.candidate.net_return=100
  assert.equal(l4ReleaseEvidenceError(b),'l4_release_reported_metric_mismatch')
})

test('Paper experiment remains explicitly unproven, not a comparative promotion',()=>{
  const a=fixture(),r:any=a.release,receipt=r.validation_receipt
  delete receipt.paired_account_comparison
  r.acceptance_mode=receipt.acceptance_mode='paper_experiment';r.efficacy_status=receipt.efficacy_status='unproven'
  receipt.experiment_authorization={scope:'paper',approved:true,source_reference:'synthetic-test-only',model_checksum:a.model_checksum}
  assert.equal(l4ReleaseEvidenceError(a),null)
  r.efficacy_status='superior';assert.equal(l4ReleaseEvidenceError(a),'l4_release_experiment_authorization_missing')
})


test('old engineering receipt cannot activate a changed runtime',()=>{
  const a=fixture();delete a.release.validation_receipt.checks.native_l3_baseline_preserved
  assert.equal(l4ReleaseEvidenceError(a),'l4_release_design_repair_evidence_missing')
})


test('Worker rejects every missing engineering proof and stale full-signal schemas',()=>{
  for (const key of L4_ACCEPTANCE_CHECKS) {
    const a=fixture();delete a.release.validation_receipt.checks[key]
    assert.notEqual(l4ReleaseEvidenceError(a),null,key)
  }
  const a=fixture();a.feature_schema='full-l3-30-calibrated-probability-v2'
  assert.equal(l4ReleaseEvidenceError(a),'l4_release_feature_schema_mismatch')
  const b=fixture();b.release.validation_receipt.feature_schema='full-l3-30-calibrated-probability-v2'
  assert.equal(l4ReleaseEvidenceError(b),'l4_release_feature_schema_mismatch')
})


function r33Fixture() {
  const a:any=fixture(), r=a.release, receipt=r.validation_receipt
  delete receipt.paired_account_comparison
  r.acceptance_mode=receipt.acceptance_mode='paper_experiment';r.efficacy_status=receipt.efficacy_status='unproven'
  receipt.experiment_authorization={scope:'paper',approved:true,source_reference:'synthetic-test-only',model_checksum:a.model_checksum}
  a.feature_schema=receipt.feature_schema=L4_R33_FEATURE_SCHEMA
  // The exact order l3_equal_weight_bundle.FEATURE_NAMES emits: z then available per model, score last.
  a.model={feature_names:['LightGBM_z','LightGBM_available','ExtraTrees_z','ExtraTrees_available','TabM_z','TabM_available',
    'GNN_z','GNN_available','TimeXer_z','TimeXer_available','PatchTST_z','PatchTST_available',
    'iTransformer_z','iTransformer_available','score']}
  return a
}

test('R33 feature schema is accepted only with the exact seven-model feature order',()=>{
  const a=r33Fixture()
  assert.equal(validL4FeatureSchema(a),true)
  assert.equal(l4ReleaseEvidenceError(a),null)
  assert.deepEqual([...R33_MODELS],['LightGBM','ExtraTrees','TabM','GNN','TimeXer','PatchTST','iTransformer'])
  const swapped=r33Fixture();[swapped.model.feature_names[0],swapped.model.feature_names[2]]=[swapped.model.feature_names[2],swapped.model.feature_names[0]]
  assert.equal(l4ReleaseEvidenceError(swapped),'l4_release_feature_schema_mismatch')
  const xgb=r33Fixture();xgb.model.feature_names.splice(2,0,'XGBoost_z','XGBoost_available')
  assert.equal(l4ReleaseEvidenceError(xgb),'l4_release_feature_schema_mismatch')
  const noScore=r33Fixture();noScore.model.feature_names.pop()
  assert.equal(l4ReleaseEvidenceError(noScore),'l4_release_feature_schema_mismatch')
  const receiptOld=r33Fixture();receiptOld.release.validation_receipt.feature_schema=L4_FEATURE_SCHEMA
  assert.equal(l4ReleaseEvidenceError(receiptOld),'l4_release_feature_schema_mismatch')
})

test('R33 operating mode and R33 feature schema must appear together',()=>{
  const artifact=r33Fixture()
  assert.equal(l4OperatingModeError({artifact,operating_mode:L4_R33_OPERATING_MODE}),null)
  assert.equal(l4OperatingModeError({artifact,operating_mode:'single_b_full_mlp_median_v1'}),'l4_operating_mode_feature_schema_mismatch')
  assert.equal(l4OperatingModeError({artifact}),'l4_operating_mode_feature_schema_mismatch')
  assert.equal(l4OperatingModeError({artifact:fixture(),operating_mode:L4_R33_OPERATING_MODE}),'l4_operating_mode_feature_schema_mismatch')
  assert.equal(l4OperatingModeError({artifact:fixture(),operating_mode:'single_b_full_mlp_median_v1'}),null)
  assert.equal(l4OperatingModeError({artifact:fixture()}),null)
})
