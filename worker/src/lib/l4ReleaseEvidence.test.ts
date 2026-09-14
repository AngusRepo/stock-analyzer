import test from 'node:test'
import assert from 'node:assert/strict'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS, l4ReleaseEvidenceError } from './l4ReleaseEvidence'

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
