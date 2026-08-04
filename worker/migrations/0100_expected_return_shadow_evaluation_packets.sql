-- Daily frozen-forward L4/Fusion evaluation evidence. These rows are not
-- model candidates, serving artifacts, training inputs, or promotion evidence.
CREATE TABLE IF NOT EXISTS expected_return_shadow_evaluation_packets (
  evaluation_id TEXT PRIMARY KEY,
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, cohort_id, extension_manifest_checksum)
);

CREATE INDEX IF NOT EXISTS idx_expected_return_shadow_eval_owner_date
  ON expected_return_shadow_evaluation_packets(
    model_name, business_date DESC, oof_max_date DESC, updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_expected_return_shadow_eval_cohort
  ON expected_return_shadow_evaluation_packets(
    cohort_id, extension_manifest_checksum, model_name
  );
