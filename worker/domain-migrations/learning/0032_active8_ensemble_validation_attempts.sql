CREATE TABLE IF NOT EXISTS active8_ensemble_validation_attempts_v1 (
  attempt_id TEXT PRIMARY KEY CHECK(length(trim(attempt_id)) > 0),
  cohort_id TEXT NOT NULL CHECK(length(trim(cohort_id)) > 0),
  training_run_id TEXT NOT NULL CHECK(length(trim(training_run_id)) > 0),
  knowledge_cutoff_date TEXT NOT NULL CHECK(length(knowledge_cutoff_date) = 10),
  schema_version TEXT NOT NULL CHECK(schema_version = 'active8-oof-ensemble-validation-attempt-v1'),
  source_manifest_checksum TEXT NOT NULL CHECK(length(source_manifest_checksum) = 64),
  observation_artifact_set_checksum TEXT NOT NULL CHECK(length(observation_artifact_set_checksum) = 64),
  validation_decision TEXT NOT NULL CHECK(validation_decision = 'FAIL'),
  validation_json TEXT NOT NULL CHECK(json_valid(validation_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_checksum TEXT NOT NULL UNIQUE CHECK(length(receipt_checksum) = 64),
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect = 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_active8_ensemble_validation_attempts_cohort
  ON active8_ensemble_validation_attempts_v1(cohort_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active8_ensemble_validation_attempts_run
  ON active8_ensemble_validation_attempts_v1(training_run_id, knowledge_cutoff_date DESC);

INSERT OR IGNORE INTO data_domain_control_revisions(table_name, revision, updated_at)
VALUES ('active8_ensemble_validation_attempts_v1', 0, CURRENT_TIMESTAMP);
