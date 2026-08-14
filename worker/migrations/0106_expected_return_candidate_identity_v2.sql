-- Repair only provably self-consistent L4 v5 / Fusion v14 candidate envelopes.
-- Idempotent: json_set writes the same canonical identity on every apply.
UPDATE model_artifact_registry
SET offline_evidence_json = json_set(
  offline_evidence_json,
  '$.identity_schema_version', 'expected-return-candidate-identity-v2',
  '$.expected_return_owner', model_name,
  '$.model_version', version,
  '$.artifact_checksum', checksum,
  '$.cadence', CASE
    WHEN json_extract(offline_evidence_json, '$.cadence') IN ('daily', 'weekly', 'monthly', 'manual', 'event-driven') THEN json_extract(offline_evidence_json, '$.cadence')
    ELSE 'weekly'
  END
)
WHERE model_name = 'l4_alpha_ev'
  AND candidate_type = 'l4_alpha_ev_refresh'
  AND artifact_id = 'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-20260809'
  AND version = 'l4-alpha-ev-ridge-v5-sector-20260809'
  AND training_run_id = 'active8_oof:active8-oof-v7-immutable-fold-evidence-2026-01-29-2026-07-22-tr60-te10'
  AND checksum = '57924157cb6dbdf6a2bf3dd50f761b900b7530884dbfbcf9595364fbfc506acf'
  AND source_run_date = '2026-08-09'
  AND upper(COALESCE(offline_gate_decision, '')) = 'FAIL'
  AND json_valid(offline_evidence_json)
  AND json_extract(offline_evidence_json, '$.artifact_contract_version') = 'l4-alpha-ev-contract-v5'
  AND json_extract(offline_evidence_json, '$.feature_semantic_version') = 'l4-directional-score-sector-components-v3-lineage-bound'
  AND json_extract(offline_evidence_json, '$.label_schema_version') = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
  AND json_extract(offline_evidence_json, '$.validation_packet.schema_version') = 'l4-alpha-ev-validation-packet-v1'
  AND upper(COALESCE(json_extract(offline_evidence_json, '$.validation_packet.decision'), '')) = upper(COALESCE(offline_gate_decision, ''))
  AND COALESCE(json_extract(offline_evidence_json, '$.expected_return_owner'), model_name) = model_name
  AND COALESCE(json_extract(offline_evidence_json, '$.model_version'), version) = version
  AND COALESCE(json_extract(offline_evidence_json, '$.identity_schema_version'), 'expected-return-candidate-identity-v2') = 'expected-return-candidate-identity-v2'
  AND COALESCE(json_extract(offline_evidence_json, '$.artifact_checksum'), checksum) = checksum;

UPDATE model_artifact_registry
SET offline_evidence_json = json_set(
  offline_evidence_json,
  '$.identity_schema_version', 'expected-return-candidate-identity-v2',
  '$.expected_return_owner', model_name,
  '$.model_version', version,
  '$.artifact_checksum', checksum,
  '$.cadence', CASE
    WHEN json_extract(offline_evidence_json, '$.cadence') IN ('daily', 'weekly', 'monthly', 'manual', 'event-driven') THEN json_extract(offline_evidence_json, '$.cadence')
    ELSE 'weekly'
  END
)
WHERE model_name = 'allocator_ev_fusion'
  AND candidate_type = 'allocator_ev_fusion_refresh'
  AND artifact_id = 'allocator_ev_fusion:allocator-ev-fusion-residual-v14-20260809'
  AND version = 'allocator-ev-fusion-residual-v14-20260809'
  AND training_run_id = 'active8_oof:active8-oof-v7-immutable-fold-evidence-2026-01-29-2026-07-22-tr60-te10'
  AND checksum = '359b98684868acaf2ba7bc4bf27575538f99a7f57f110d8a53e67a52dcbe5d15'
  AND source_run_date = '2026-08-09'
  AND upper(COALESCE(offline_gate_decision, '')) = 'FAIL'
  AND json_valid(offline_evidence_json)
  AND json_extract(offline_evidence_json, '$.artifact_contract_version') = 'allocator-ev-fusion-contract-v14'
  AND json_extract(offline_evidence_json, '$.feature_semantic_version') = 'allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound'
  AND json_extract(offline_evidence_json, '$.label_schema_version') = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
  AND json_extract(offline_evidence_json, '$.validation_packet.schema_version') = 'allocator-ev-fusion-validation-packet-v14'
  AND upper(COALESCE(json_extract(offline_evidence_json, '$.validation_packet.decision'), '')) = upper(COALESCE(offline_gate_decision, ''))
  AND COALESCE(json_extract(offline_evidence_json, '$.expected_return_owner'), model_name) = model_name
  AND COALESCE(json_extract(offline_evidence_json, '$.model_version'), version) = version
  AND COALESCE(json_extract(offline_evidence_json, '$.identity_schema_version'), 'expected-return-candidate-identity-v2') = 'expected-return-candidate-identity-v2'
  AND COALESCE(json_extract(offline_evidence_json, '$.artifact_checksum'), checksum) = checksum;
