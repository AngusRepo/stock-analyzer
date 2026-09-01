-- Exact, post-freeze forward evidence for immutable L4/Fusion candidates.
-- Rows at or before source_run_date are prohibited to prevent lookahead reuse.

CREATE TABLE IF NOT EXISTS expected_return_candidate_forward_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  candidate_artifact_id TEXT NOT NULL,
  candidate_artifact_checksum TEXT NOT NULL CHECK(length(candidate_artifact_checksum)=64),
  model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
  model_version TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL CHECK(length(model_fingerprint)=64),
  cohort_id TEXT NOT NULL,
  source_run_date TEXT NOT NULL,
  extension_manifest_checksum TEXT NOT NULL CHECK(length(extension_manifest_checksum)=64),
  prediction_date TEXT NOT NULL CHECK(prediction_date > source_run_date),
  label_known_date TEXT NOT NULL CHECK(label_known_date > prediction_date),
  sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
  prediction_corr REAL,
  baseline_corr REAL,
  corr_delta REAL,
  spread REAL,
  baseline_spread REAL,
  spread_delta REAL,
  top_return REAL,
  quality_decision TEXT NOT NULL CHECK(quality_decision IN ('PASS','DEGRADED','INSUFFICIENT')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(candidate_artifact_id, model_fingerprint, prediction_date)
);

CREATE INDEX IF NOT EXISTS idx_expected_return_candidate_forward_identity_date
  ON expected_return_candidate_forward_evaluations(
    candidate_artifact_id, model_fingerprint, prediction_date DESC
  );
