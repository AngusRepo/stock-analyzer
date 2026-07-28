-- Contract-valid no-trade owners keep serving lineage explicit while learned
-- L4/Fusion challengers remain shadow until quality and parity pass.

CREATE TABLE IF NOT EXISTS expected_return_artifact_payloads (
  artifact_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
  model_version TEXT NOT NULL,
  serving_mode TEXT NOT NULL CHECK(serving_mode IN ('alpha','abstention_baseline')),
  artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  source_artifact_path TEXT,
  source_artifact_checksum TEXT,
  source_cohort_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(artifact_id) REFERENCES model_artifact_registry(artifact_id) ON DELETE RESTRICT,
  UNIQUE(model_name, model_version)
);

CREATE INDEX IF NOT EXISTS idx_expected_return_artifact_payloads_owner
  ON expected_return_artifact_payloads(model_name, serving_mode, updated_at DESC);

INSERT INTO model_artifact_registry (
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, trained_from_snapshot,
  feature_policy_version, checksum, source_run_date, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state
) VALUES (
  'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1', 'l4_alpha_ev',
  'l4-alpha-ev-abstention-baseline-v1', 'unknown', 'production',
  'builtin://expected-return/l4-alpha-ev-abstention-baseline-v1',
  'builtin://expected-return/l4-alpha-ev-abstention-baseline-v1',
  'expected-return-serving-baseline-v1', 'none:no_alpha_claim',
  'l4-alpha-ev-contract-v4',
  'f14f7aa15deea84e592c91fbe372e656f8948a519442d2456a8bc25f71cd5167',
  date('now'), 'passed', 'PASS', '[]',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","decision":"PASS","scope":"operational_safety_only","alpha_quality_passed":false}',
  'promoted',
  '{"serving_mode":"abstention_baseline","expected_return_action_gate":"validated_s12_only"}',
  'bootstrap_abstention_baseline', 'not_required'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO model_artifact_registry (
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, trained_from_snapshot,
  feature_policy_version, checksum, source_run_date, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state
) VALUES (
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1',
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v1',
  'unknown', 'production',
  'builtin://expected-return/allocator-ev-fusion-abstention-baseline-v1',
  'builtin://expected-return/allocator-ev-fusion-abstention-baseline-v1',
  'expected-return-serving-baseline-v1', 'none:no_alpha_claim',
  'allocator-ev-fusion-contract-v12',
  '78889854d0f9ef5bf630415707517915c3887bcb928f6f747893f40d57906cf1',
  date('now'), 'passed', 'PASS', '[]',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","decision":"PASS","scope":"operational_safety_only","alpha_quality_passed":false}',
  'promoted',
  '{"serving_mode":"abstention_baseline","expected_return_action_gate":"validated_s12_only"}',
  'bootstrap_abstention_baseline', 'not_required'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO expected_return_artifact_payloads (
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id
) VALUES (
  'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1', 'l4_alpha_ev',
  'l4-alpha-ev-abstention-baseline-v1', 'abstention_baseline',
  '{"artifact_contract_version":"l4-alpha-ev-contract-v4","expected_return_owner":"l4_alpha_ev","feature_semantic_version":"l4-directional-score-components-v2-lineage-bound","label_schema_version":"next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4","model_version":"l4-alpha-ev-abstention-baseline-v1","output_is_net_of_costs":true,"promotion_state":"safe_abstention","serving_mode":"abstention_baseline","validation_packet":{"alpha_quality_passed":false,"decision":"PASS","schema_version":"expected-return-abstention-baseline-validation-v1","scope":"operational_safety_only"}}',
  'f14f7aa15deea84e592c91fbe372e656f8948a519442d2456a8bc25f71cd5167',
  'builtin://expected-return/l4-alpha-ev-abstention-baseline-v1',
  'f14f7aa15deea84e592c91fbe372e656f8948a519442d2456a8bc25f71cd5167',
  'expected-return-serving-baseline-v1'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO expected_return_artifact_payloads (
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id
) VALUES (
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1',
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v1',
  'abstention_baseline',
  '{"artifact_contract_version":"allocator-ev-fusion-contract-v12","expected_return_owner":"allocator_ev_fusion","feature_semantic_version":"allocator-ev-fusion-market-conditioned-components-v3-lineage-bound","label_schema_version":"next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4","model_version":"allocator-ev-fusion-abstention-baseline-v1","output_is_net_of_costs":true,"primary_expected_return_allowed":false,"promotion_state":"safe_abstention","serving_mode":"abstention_baseline","validation_packet":{"alpha_quality_passed":false,"decision":"PASS","schema_version":"expected-return-abstention-baseline-validation-v1","scope":"operational_safety_only"}}',
  '78889854d0f9ef5bf630415707517915c3887bcb928f6f747893f40d57906cf1',
  'builtin://expected-return/allocator-ev-fusion-abstention-baseline-v1',
  '78889854d0f9ef5bf630415707517915c3887bcb928f6f747893f40d57906cf1',
  'expected-return-serving-baseline-v1'
) ON CONFLICT(artifact_id) DO NOTHING;

INSERT INTO model_champion_pointers (
  model_name, champion_version, champion_artifact_id,
  rollback_version, rollback_artifact_id, promoted_at,
  promotion_reason, promotion_evidence_json, updated_at
) VALUES (
  'l4_alpha_ev', 'l4-alpha-ev-abstention-baseline-v1',
  'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1', NULL, NULL,
  CURRENT_TIMESTAMP, 'contract_valid_abstention_bootstrap',
  '{"schema_version":"expected-return-pointer-promotion-v1","serving_mode":"abstention_baseline","alpha_quality_passed":false}',
  CURRENT_TIMESTAMP
) ON CONFLICT(model_name) DO NOTHING;

INSERT INTO model_champion_pointers (
  model_name, champion_version, champion_artifact_id,
  rollback_version, rollback_artifact_id, promoted_at,
  promotion_reason, promotion_evidence_json, updated_at
) VALUES (
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v1',
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1', NULL, NULL,
  CURRENT_TIMESTAMP, 'contract_valid_abstention_bootstrap',
  '{"schema_version":"expected-return-pointer-promotion-v1","serving_mode":"abstention_baseline","alpha_quality_passed":false}',
  CURRENT_TIMESTAMP
) ON CONFLICT(model_name) DO NOTHING;

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at,
  retired_at, source, evidence_grade, evidence_json
) VALUES (
  'expected-return:l4_alpha_ev:abstention-baseline-v1', 'l4_alpha_ev',
  'l4-alpha-ev-abstention-baseline-v1',
  'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1',
  CURRENT_TIMESTAMP, NULL, 'model_champion_history', 'exact',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","alpha_quality_passed":false}'
);

UPDATE model_artifact_registry
   SET state = 'archived',
       promotion_decision = 'baseline_retained_for_rollback',
       updated_at = CURRENT_TIMESTAMP
 WHERE artifact_id IN (
   'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1',
   'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1'
 )
   AND EXISTS (
     SELECT 1 FROM model_champion_pointers pointer
      WHERE pointer.model_name = model_artifact_registry.model_name
        AND pointer.champion_artifact_id != model_artifact_registry.artifact_id
   );

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at,
  retired_at, source, evidence_grade, evidence_json
) VALUES (
  'expected-return:allocator_ev_fusion:abstention-baseline-v1',
  'allocator_ev_fusion', 'allocator-ev-fusion-abstention-baseline-v1',
  'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1',
  CURRENT_TIMESTAMP, NULL, 'model_champion_history', 'exact',
  '{"schema_version":"expected-return-abstention-baseline-evidence-v1","alpha_quality_passed":false}'
);

UPDATE model_champion_history
   SET retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)
 WHERE artifact_id IN (
   'l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1',
   'allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v1'
 )
   AND EXISTS (
     SELECT 1
       FROM model_champion_pointers pointer
      WHERE pointer.model_name = model_champion_history.model_name
        AND pointer.champion_artifact_id != model_champion_history.artifact_id
   );
