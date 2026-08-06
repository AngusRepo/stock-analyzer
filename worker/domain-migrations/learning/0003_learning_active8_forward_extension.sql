-- Compact, checksum-bound monitoring coverage for frozen-forward OOF evidence.
-- These rows may satisfy daily freshness monitoring, but are never serving or
-- promotion artifacts and must not be joined into canonical training indexes.

CREATE TABLE IF NOT EXISTS active8_oof_forward_extension_coverage (
  cohort_id TEXT NOT NULL,
  extension_manifest_checksum TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK(
    artifact_kind IN ('allocator_ev_snapshots', 'l4_predictions')
  ),
  base_manifest_checksum TEXT NOT NULL,
  extension_manifest_path TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  min_date TEXT NOT NULL,
  max_date TEXT NOT NULL,
  date_count INTEGER NOT NULL CHECK(date_count >= 0),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  date_checksum TEXT NOT NULL,
  coverage_status TEXT NOT NULL CHECK(coverage_status IN ('verified', 'partial')),
  promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible = 0),
  training_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(training_dispatched = 0),
  policy_version TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(cohort_id, extension_manifest_checksum, artifact_kind)
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_forward_coverage_freshness
  ON active8_oof_forward_extension_coverage(artifact_kind, coverage_status, max_date DESC, knowledge_cutoff_date);
