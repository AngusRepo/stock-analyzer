-- Make frozen-forward L4/L4+ shadow evaluations append-only and content-addressed.
-- Existing v1 packets remain queryable but are marked legacy because their subject/evaluator
-- hashes cannot be reconstructed safely from D1 columns alone.
DROP INDEX IF EXISTS idx_expected_return_shadow_eval_owner_date;
DROP INDEX IF EXISTS idx_expected_return_shadow_eval_cohort;

ALTER TABLE expected_return_shadow_evaluation_packets
  RENAME TO expected_return_shadow_evaluation_packets_legacy_0111;

CREATE TABLE expected_return_shadow_evaluation_packets (
  evaluation_id TEXT NOT NULL PRIMARY KEY,
  identity_schema_version TEXT NOT NULL CHECK(identity_schema_version IN (
    'expected-return-shadow-evaluation-identity-legacy-v1',
    'expected-return-shadow-evaluation-identity-v2'
  )),
  subject_artifact_checksum TEXT
    CHECK(subject_artifact_checksum IS NULL OR length(subject_artifact_checksum) = 64),
  evaluator_contract_checksum TEXT
    CHECK(evaluator_contract_checksum IS NULL OR length(evaluator_contract_checksum) = 64),
  business_date TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  base_manifest_checksum TEXT NOT NULL CHECK(length(base_manifest_checksum) = 64),
  extension_manifest_checksum TEXT NOT NULL CHECK(length(extension_manifest_checksum) = 64),
  model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
  model_version TEXT NOT NULL,
  oof_min_date TEXT NOT NULL,
  oof_max_date TEXT NOT NULL,
  oof_date_count INTEGER NOT NULL CHECK(oof_date_count > 0),
  oof_row_count INTEGER NOT NULL CHECK(oof_row_count > 0),
  quality_decision TEXT NOT NULL,
  policy_decision TEXT NOT NULL CHECK(policy_decision = 'shadow_only'),
  validation_packet_json TEXT NOT NULL CHECK(json_valid(validation_packet_json)),
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL CHECK(length(artifact_checksum) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO expected_return_shadow_evaluation_packets (
  evaluation_id, identity_schema_version, subject_artifact_checksum,
  evaluator_contract_checksum, business_date, cohort_id, base_manifest_checksum,
  extension_manifest_checksum, model_name, model_version, oof_min_date, oof_max_date,
  oof_date_count, oof_row_count, quality_decision, policy_decision,
  validation_packet_json, artifact_path, artifact_checksum, created_at, updated_at
)
SELECT
  evaluation_id, 'expected-return-shadow-evaluation-identity-legacy-v1', NULL,
  NULL, business_date, cohort_id, base_manifest_checksum,
  extension_manifest_checksum, model_name, model_version, oof_min_date, oof_max_date,
  oof_date_count, oof_row_count, quality_decision, policy_decision,
  validation_packet_json, artifact_path, artifact_checksum, created_at, updated_at
FROM expected_return_shadow_evaluation_packets_legacy_0111;

DROP TABLE expected_return_shadow_evaluation_packets_legacy_0111;

CREATE INDEX idx_expected_return_shadow_eval_owner_date
  ON expected_return_shadow_evaluation_packets(
    model_name, business_date DESC, oof_max_date DESC, updated_at DESC
  );

CREATE INDEX idx_expected_return_shadow_eval_cohort
  ON expected_return_shadow_evaluation_packets(
    cohort_id, extension_manifest_checksum, model_name
  );

CREATE INDEX idx_expected_return_shadow_eval_identity_v2
  ON expected_return_shadow_evaluation_packets(
    model_name, subject_artifact_checksum, evaluator_contract_checksum, artifact_checksum
  );
