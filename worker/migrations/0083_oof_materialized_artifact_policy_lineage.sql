-- A smaller OOF artifact may be more correct when a stricter PIT policy removes
-- hindsight rows. Preserve the replaced immutable object and its reason.

ALTER TABLE active8_oof_materialized_artifacts
  ADD COLUMN eligibility_policy_version TEXT NOT NULL DEFAULT 'legacy-unversioned';
ALTER TABLE active8_oof_materialized_artifacts
  ADD COLUMN date_set_checksum TEXT;
ALTER TABLE active8_oof_materialized_artifacts
  ADD COLUMN replacement_reason TEXT;

CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifact_history (
  cohort_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  format_version TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  date_count INTEGER NOT NULL,
  min_date TEXT,
  max_date TEXT,
  compressed_bytes INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  source_manifest_checksum TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL,
  date_set_checksum TEXT,
  replaced_by_checksum TEXT NOT NULL,
  replacement_reason TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, artifact_kind, artifact_checksum),
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(length(replaced_by_checksum) = 64),
  CHECK(date_set_checksum IS NULL OR length(date_set_checksum) = 64)
);

CREATE INDEX IF NOT EXISTS idx_oof_materialized_history_replacement
  ON active8_oof_materialized_artifact_history(
    cohort_id, artifact_kind, replaced_by_checksum
  );
