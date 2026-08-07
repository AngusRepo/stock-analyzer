-- Cut the Fusion safety control over to the same v13 contract as challengers.
-- This is a no-trade operational baseline, never an alpha promotion.

INSERT INTO model_artifact_registry (
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, trained_from_snapshot,
  feature_policy_version, checksum, source_run_date, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state
) VALUES (
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13',
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v13',
  'unknown', 'production',
  'builtin://expected-return/allocator-ev-fusion-abstention-baseline-v13',
  'builtin://expected-return/allocator-ev-fusion-abstention-baseline-v13',
  'expected-return-serving-baseline-v13', 'none:no_alpha_claim',
  'allocator-ev-fusion-contract-v13',
  '2c6d04e83a8c121d83762cbaa1c8210fdb81352d66d5216984a0179fdccf66cd',
  date('now'), 'passed', 'PASS', '[]',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v2","decision":"PASS","scope":"operational_safety_only","alpha_quality_passed":false,"statistical_claim":"none","comparison_policy":"same_contract_same_oof_panel"}',
  'promoted',
  '{"serving_mode":"abstention_baseline","expected_return_action_gate":"fusion_primary_required","benchmark_role":"same_contract_no_trade_policy_value_baseline"}',
  'contract_valid_abstention_baseline_v13', 'not_required'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO expected_return_artifact_payloads (
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id
) VALUES (
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13',
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v13',
  'abstention_baseline',
  '{"artifact_contract_version":"allocator-ev-fusion-contract-v13","benchmark_role":"same_contract_no_trade_policy_value_baseline","conditional_execution_return_model":{"coefficients":{"l4_expected_return":0},"intercept":0,"model_type":"constant_abstention_control","output_semantics":"expected_net_return_given_execution","training_scope":"none_operational_control"},"execution_probability_model":{"coefficients":{"l4_available":0},"intercept":0,"model_type":"constant_abstention_control","output_semantics":"execution_probability","training_scope":"none_operational_control"},"expected_return_owner":"allocator_ev_fusion","feature_semantic_version":"allocator-ev-fusion-s12-policy-value-day-t-causal-v4-lineage-bound","label_schema_version":"next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4","model_version":"allocator-ev-fusion-abstention-baseline-v13","output_is_net_of_costs":true,"policy_value_head_count":2,"policy_value_heads":["execution_probability_model","conditional_execution_return_model"],"primary_expected_return_allowed":false,"promotion_state":"safe_abstention","serving_mode":"abstention_baseline","validation_packet":{"alpha_quality_passed":false,"comparison_policy":"challengers_are_compared_on_same_purged_oof_date_panel_against_no_trade_and_canonical_l4","decision":"PASS","schema_version":"expected-return-abstention-baseline-validation-v2","scope":"operational_safety_only","statistical_claim":"none"}}',
  '2c6d04e83a8c121d83762cbaa1c8210fdb81352d66d5216984a0179fdccf66cd',
  'builtin://expected-return/allocator-ev-fusion-abstention-baseline-v13',
  '2c6d04e83a8c121d83762cbaa1c8210fdb81352d66d5216984a0179fdccf66cd',
  'expected-return-serving-baseline-v13'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO model_champion_pointers (
  model_name, champion_version, champion_artifact_id,
  rollback_version, rollback_artifact_id, promoted_at,
  promotion_reason, promotion_evidence_json, updated_at
) VALUES (
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v13',
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13', NULL, NULL,
  CURRENT_TIMESTAMP, 'contract_valid_abstention_baseline_v13_cutover',
  '{"schema_version":"expected-return-pointer-promotion-v2","serving_mode":"abstention_baseline","alpha_quality_passed":false,"artifact_contract_version":"allocator-ev-fusion-contract-v13"}',
  CURRENT_TIMESTAMP
) ON CONFLICT(model_name) DO NOTHING;

UPDATE model_champion_pointers
   SET rollback_version = champion_version,
       rollback_artifact_id = champion_artifact_id,
       champion_version = 'allocator-ev-fusion-abstention-baseline-v13',
       champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13',
       promoted_at = CURRENT_TIMESTAMP,
       promotion_reason = 'contract_valid_abstention_baseline_v13_cutover',
       promotion_evidence_json = '{"schema_version":"expected-return-pointer-promotion-v2","serving_mode":"abstention_baseline","alpha_quality_passed":false,"artifact_contract_version":"allocator-ev-fusion-contract-v13"}',
       updated_at = CURRENT_TIMESTAMP
 WHERE model_name = 'allocator_ev_fusion'
   AND champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1';

UPDATE model_artifact_registry
   SET state = 'archived',
       promotion_decision = 'superseded_by_v13_abstention_baseline',
       updated_at = CURRENT_TIMESTAMP
 WHERE artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1'
   AND EXISTS (
     SELECT 1 FROM model_champion_pointers
      WHERE model_name = 'allocator_ev_fusion'
        AND champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13'
   );

UPDATE model_champion_history
   SET retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)
 WHERE artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1'
   AND EXISTS (
     SELECT 1 FROM model_champion_pointers
      WHERE model_name = 'allocator_ev_fusion'
        AND champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13'
   );

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at,
  retired_at, source, evidence_grade, evidence_json
)
SELECT
  'expected-return:allocator_ev_fusion:abstention-baseline-v13',
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v13',
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13',
  CURRENT_TIMESTAMP, NULL, 'model_champion_history', 'exact',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v2","alpha_quality_passed":false,"artifact_contract_version":"allocator-ev-fusion-contract-v13","benchmark_role":"same_contract_no_trade_policy_value_baseline"}'
 WHERE EXISTS (
   SELECT 1 FROM model_champion_pointers
    WHERE model_name = 'allocator_ev_fusion'
      AND champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13'
 );
