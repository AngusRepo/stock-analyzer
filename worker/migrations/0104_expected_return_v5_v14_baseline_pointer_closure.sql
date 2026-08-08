-- Align abstention baselines with the L4 v5 and Fusion v14 serving contracts.
-- Fail-safe rule: only bootstrap a missing pointer or replace a known abstention
-- baseline. Never overwrite a learned alpha champion.

INSERT INTO model_artifact_registry (
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, trained_from_snapshot,
  feature_policy_version, checksum, source_run_date, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state
) VALUES (
  'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'l4_alpha_ev', 'l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'unknown', 'production',
  'builtin://expected-return/l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'builtin://expected-return/l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'expected-return-serving-baseline-v5', 'none:no_alpha_claim',
  'l4-alpha-ev-contract-v5',
  '6b7eca755db2cb8b296a26e80bf80fcf2abb4ba45825baa9d744fb629f0feddf',
  date('now'), 'passed', 'PASS', '[]',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","decision":"PASS","scope":"operational_safety_only","alpha_quality_passed":false}',
  'promoted',
  '{"serving_mode":"abstention_baseline","expected_return_action_gate":"canonical_l4_only"}',
  'contract_aligned_abstention_baseline', 'not_required'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO model_artifact_registry (
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, trained_from_snapshot,
  feature_policy_version, checksum, source_run_date, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state
) VALUES (
  'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'allocator_ev_fusion', 'allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'unknown', 'production',
  'builtin://expected-return/allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'builtin://expected-return/allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'expected-return-serving-baseline-v14', 'none:no_alpha_claim',
  'allocator-ev-fusion-contract-v14',
  '14bfe2f03dc9d4572ca738e9e27b027314065f76a780dc8704d2750feb1837d4',
  date('now'), 'passed', 'PASS', '[]',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","decision":"PASS","scope":"operational_safety_only","alpha_quality_passed":false}',
  'promoted',
  '{"serving_mode":"abstention_baseline","expected_return_action_gate":"validated_residual_only"}',
  'contract_aligned_abstention_baseline', 'not_required'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO expected_return_artifact_payloads (
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id
) VALUES (
  'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'l4_alpha_ev', 'l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'abstention_baseline',
  '{"artifact_contract_version":"l4-alpha-ev-contract-v5","expected_return_owner":"l4_alpha_ev","feature_semantic_version":"l4-directional-score-sector-components-v3-lineage-bound","label_schema_version":"next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4","model_version":"l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1","output_is_net_of_costs":true,"promotion_state":"safe_abstention","serving_mode":"abstention_baseline","validation_packet":{"alpha_quality_passed":false,"decision":"PASS","schema_version":"expected-return-abstention-baseline-validation-v1","scope":"operational_safety_only"}}',
  '6b7eca755db2cb8b296a26e80bf80fcf2abb4ba45825baa9d744fb629f0feddf',
  'builtin://expected-return/l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  '6b7eca755db2cb8b296a26e80bf80fcf2abb4ba45825baa9d744fb629f0feddf',
  'expected-return-serving-baseline-v5'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO expected_return_artifact_payloads (
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id
) VALUES (
  'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'allocator_ev_fusion', 'allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'abstention_baseline',
  '{"artifact_contract_version":"allocator-ev-fusion-contract-v14","expected_return_owner":"allocator_ev_fusion","feature_semantic_version":"allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound","label_schema_version":"next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4","model_version":"allocator-ev-fusion-residual-v14-abstention-baseline-v1","output_is_net_of_costs":true,"primary_expected_return_allowed":false,"promotion_state":"safe_abstention","serving_mode":"abstention_baseline","validation_packet":{"alpha_quality_passed":false,"decision":"PASS","schema_version":"expected-return-abstention-baseline-validation-v1","scope":"operational_safety_only"}}',
  '14bfe2f03dc9d4572ca738e9e27b027314065f76a780dc8704d2750feb1837d4',
  'builtin://expected-return/allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  '14bfe2f03dc9d4572ca738e9e27b027314065f76a780dc8704d2750feb1837d4',
  'expected-return-serving-baseline-v14'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO model_champion_pointers (
  model_name, champion_version, champion_artifact_id,
  rollback_version, rollback_artifact_id, promoted_at,
  promotion_reason, promotion_evidence_json, updated_at
)
SELECT
  'l4_alpha_ev', 'l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  NULL, NULL, CURRENT_TIMESTAMP, 'contract_aligned_abstention_bootstrap',
  '{"schema_version":"expected-return-pointer-promotion-v1","serving_mode":"abstention_baseline","alpha_quality_passed":false,"artifact_contract_version":"l4-alpha-ev-contract-v5"}',
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM model_champion_pointers WHERE model_name = 'l4_alpha_ev'
);

UPDATE model_champion_pointers
   SET champion_version = 'l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
       champion_artifact_id = 'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
       promoted_at = CURRENT_TIMESTAMP,
       promotion_reason = 'contract_aligned_abstention_rotation',
       promotion_evidence_json = '{"schema_version":"expected-return-pointer-promotion-v1","serving_mode":"abstention_baseline","alpha_quality_passed":false,"artifact_contract_version":"l4-alpha-ev-contract-v5"}',
       updated_at = CURRENT_TIMESTAMP
 WHERE model_name = 'l4_alpha_ev'
   AND champion_artifact_id = 'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1';

INSERT INTO model_champion_pointers (
  model_name, champion_version, champion_artifact_id,
  rollback_version, rollback_artifact_id, promoted_at,
  promotion_reason, promotion_evidence_json, updated_at
)
SELECT
  'allocator_ev_fusion', 'allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  NULL, NULL, CURRENT_TIMESTAMP, 'contract_aligned_abstention_bootstrap',
  '{"schema_version":"expected-return-pointer-promotion-v1","serving_mode":"abstention_baseline","alpha_quality_passed":false,"artifact_contract_version":"allocator-ev-fusion-contract-v14"}',
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM model_champion_pointers WHERE model_name = 'allocator_ev_fusion'
);

UPDATE model_champion_pointers
   SET champion_version = 'allocator-ev-fusion-residual-v14-abstention-baseline-v1',
       champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1',
       promoted_at = CURRENT_TIMESTAMP,
       promotion_reason = 'contract_aligned_abstention_rotation',
       promotion_evidence_json = '{"schema_version":"expected-return-pointer-promotion-v1","serving_mode":"abstention_baseline","alpha_quality_passed":false,"artifact_contract_version":"allocator-ev-fusion-contract-v14"}',
       updated_at = CURRENT_TIMESTAMP
 WHERE model_name = 'allocator_ev_fusion'
   AND champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1';

UPDATE model_artifact_registry
   SET state = 'archived',
       promotion_decision = 'superseded_contract_abstention_baseline',
       updated_at = CURRENT_TIMESTAMP
 WHERE artifact_id IN (
   'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1',
   'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1'
 )
   AND NOT EXISTS (
     SELECT 1 FROM model_champion_pointers pointer
      WHERE pointer.champion_artifact_id = model_artifact_registry.artifact_id
   );

UPDATE model_artifact_registry
   SET state = 'production',
       updated_at = CURRENT_TIMESTAMP
 WHERE artifact_id IN (
   'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
   'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1'
 )
   AND EXISTS (
     SELECT 1 FROM model_champion_pointers pointer
      WHERE pointer.champion_artifact_id = model_artifact_registry.artifact_id
   );

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at,
  retired_at, source, evidence_grade, evidence_json
)
SELECT
  'expected-return:l4_alpha_ev:abstention-baseline-v5',
  'l4_alpha_ev', 'l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
  CURRENT_TIMESTAMP, NULL, 'model_champion_history', 'exact',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","artifact_contract_version":"l4-alpha-ev-contract-v5","alpha_quality_passed":false}'
WHERE EXISTS (
  SELECT 1 FROM model_champion_pointers
   WHERE model_name = 'l4_alpha_ev'
     AND champion_artifact_id = 'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1'
);

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at,
  retired_at, source, evidence_grade, evidence_json
)
SELECT
  'expected-return:allocator_ev_fusion:abstention-baseline-v14',
  'allocator_ev_fusion', 'allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1',
  CURRENT_TIMESTAMP, NULL, 'model_champion_history', 'exact',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","artifact_contract_version":"allocator-ev-fusion-contract-v14","alpha_quality_passed":false}'
WHERE EXISTS (
  SELECT 1 FROM model_champion_pointers
   WHERE model_name = 'allocator_ev_fusion'
     AND champion_artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1'
);

UPDATE model_champion_history
   SET retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)
 WHERE artifact_id IN (
   'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1',
   'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1'
 )
   AND EXISTS (
     SELECT 1 FROM model_champion_pointers pointer
      WHERE pointer.model_name = model_champion_history.model_name
        AND pointer.champion_artifact_id != model_champion_history.artifact_id
   );
