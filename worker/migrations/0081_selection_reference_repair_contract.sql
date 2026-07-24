-- Keep historical L0 reference reconstruction independent from strategy-matrix learning.
ALTER TABLE selection_reference_snapshots_v1
  ADD COLUMN reference_source TEXT NOT NULL DEFAULT 'native'
  CHECK(reference_source IN ('native', 'historical_reconstruction'));
ALTER TABLE selection_reference_snapshots_v1
  ADD COLUMN strategy_matrix_status TEXT NOT NULL DEFAULT 'ready'
  CHECK(strategy_matrix_status IN ('ready', 'unavailable'));
ALTER TABLE selection_reference_snapshots_v1
  ADD COLUMN reconstruction_reason TEXT;
ALTER TABLE selection_reference_snapshots_v1
  ADD COLUMN source_artifact_checksum TEXT;

CREATE TABLE IF NOT EXISTS selection_reference_repair_runs_v1 (
  signal_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  expected_rows INTEGER NOT NULL,
  persisted_rows INTEGER NOT NULL DEFAULT 0,
  source_artifact_id TEXT NOT NULL,
  source_artifact_checksum TEXT NOT NULL,
  source_artifact_schema TEXT NOT NULL,
  strategy_matrix_status TEXT NOT NULL CHECK(strategy_matrix_status IN ('ready', 'unavailable')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, producer_run_id)
);