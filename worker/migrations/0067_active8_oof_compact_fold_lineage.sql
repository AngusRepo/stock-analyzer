-- Keep immutable raw OOF predictions in checksum-addressed GCS artifacts.
-- D1 stores a compact fold index plus materialized L4/Fusion evidence.

ALTER TABLE active8_oof_cohorts ADD COLUMN prediction_storage_mode TEXT NOT NULL DEFAULT 'd1_full_v1';
ALTER TABLE active8_oof_cohorts ADD COLUMN parent_cohort_id TEXT;
ALTER TABLE active8_oof_cohorts ADD COLUMN parent_manifest_checksum TEXT;

CREATE TABLE IF NOT EXISTS active8_oof_fold_artifacts (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  source_cohort_id TEXT NOT NULL,
  source_manifest_checksum TEXT NOT NULL,
  model_name TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  artifact_rows INTEGER NOT NULL DEFAULT 0,
  prediction_dates INTEGER NOT NULL DEFAULT 0,
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, model_name),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(train_end < test_start)
);
CREATE INDEX IF NOT EXISTS idx_active8_oof_fold_artifacts_source
  ON active8_oof_fold_artifacts(source_cohort_id, fold_id, model_name);
