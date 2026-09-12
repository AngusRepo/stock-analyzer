import assert from 'node:assert/strict'
import { adaptExpectedReturnShadow, type ExpectedReturnShadowDbRow } from './expectedReturnMaturityEvidence'

const packet = {
  schema_version: 'l4-alpha-ev-validation-packet-v1', decision: 'FAIL',
  sample_audit: { oof_max_date: '2026-08-18', evidence_max_date: '2026-08-18', sample_count: 7744, date_count: 24 },
  diagnostic_population: { schema_version: 'expected-return-rolling-population-v1',
    promotion_eligible: false, usable_max_date: '2026-08-18',
    available_dates: ['2026-08-18', '2026-09-03'], evaluated_dates: ['2026-08-18'], extension_dates: ['2026-09-03'] },
  oos_metrics: { date_mean_cross_section_corr_lcb90: -0.04252319,
    date_mean_top_bottom_spread_lcb90: -0.01152158, top_quintile_mean_return: 0.0018182,
    date_mean_top_quintile_return_lcb90: -0.02895655, evaluated_dates: ['2026-08-18'] },
  walk_forward: { passed: false }, failed_gates: ['offline_quality_failure'],
}
const row: ExpectedReturnShadowDbRow = {
  evaluation_id: 'e'.repeat(64), identity_schema_version: 'expected-return-shadow-evaluation-identity-v2',
  subject_artifact_checksum: '1'.repeat(64), evaluator_contract_checksum: '2'.repeat(64),
  cohort_id: 'original-cohort', base_manifest_checksum: 'a'.repeat(64), extension_manifest_checksum: 'b'.repeat(64),
  artifact_path: `shadow/${'c'.repeat(64)}.json`, artifact_checksum: 'c'.repeat(64),
  business_date: '2026-09-10', model_name: 'l4_alpha_ev', model_version: 'l4-alpha-ev-ridge-v5-sector-20260818',
  oof_min_date: '2026-08-19', oof_max_date: '2026-09-03', oof_date_count: 12, oof_row_count: 95740,
  quality_decision: 'FAIL', policy_decision: 'shadow_only', validation_packet_json: JSON.stringify(packet),
  updated_at: '2026-09-10T15:00:00Z',
}
// Real incident: extension metadata advanced while validation stayed on base dates.
const result = adaptExpectedReturnShadow(row)
assert.equal(result.identity_valid, true)
assert.equal(result.validation_scope, 'base_cohort_offline_validation')
for (const key of ['l4_corr_lcb90','l4_spread_lcb90','l4_top_return','l4_top_lcb90','walk_forward_passed'] as const) {
  assert.equal(result[key], null)
}
assert.equal(result.quality_decision, 'NOT_EVALUATED')
assert.deepEqual(result.failed_gates, [])
assert.equal(result.oof_max_date, '2026-09-03')
assert.equal(result.oof_date_count, 12)
assert.equal(result.sample_count, 7744)
// Equal numeric values alone must not suppress independently evaluated evidence.
const evaluated = adaptExpectedReturnShadow({ ...row, validation_packet_json: JSON.stringify({
  ...packet, sample_audit: { ...packet.sample_audit, oof_max_date: '2026-09-03', evidence_max_date: '2026-09-03' },
  diagnostic_population: { ...packet.diagnostic_population, usable_max_date: '2026-09-03', evaluated_dates: ['2026-09-03'] },
  oos_metrics: { ...packet.oos_metrics, evaluated_dates: ['2026-09-03'] },
}) })
assert.equal(evaluated.l4_corr_lcb90, packet.oos_metrics.date_mean_cross_section_corr_lcb90)
assert.equal(evaluated.quality_decision, 'FAIL')
const explicit = adaptExpectedReturnShadow({ ...row, validation_packet_json: JSON.stringify({
  ...packet, monitoring_policy: { validation_scope: 'base_cohort_offline_validation' },
}) })
assert.equal(explicit.l4_top_return, null)
const unverified = adaptExpectedReturnShadow({ ...row, validation_packet_json: JSON.stringify({
  ...packet, diagnostic_population: undefined,
}) })
assert.equal(unverified.identity_valid, false)
assert.equal(unverified.l4_corr_lcb90, null)
console.log('shadow scope regression passed')
