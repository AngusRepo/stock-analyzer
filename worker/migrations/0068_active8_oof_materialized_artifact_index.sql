-- Large OOF snapshots and L4 predictions are immutable offline evidence.
-- Keep checksum-addressed payloads in GCS and only their compact index in D1.

CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifacts (
  cohort_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('allocator_ev_snapshots','l4_predictions')),
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  format_version TEXT NOT NULL CHECK(format_version = 'active8-oof-materialized-jsonl-gzip-v1'),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  date_count INTEGER NOT NULL CHECK(date_count >= 0),
  min_date TEXT,
  max_date TEXT,
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
  source_manifest_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, artifact_kind),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(min_date IS NULL OR max_date IS NULL OR min_date <= max_date)
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_materialized_artifacts_checksum
  ON active8_oof_materialized_artifacts(artifact_checksum);