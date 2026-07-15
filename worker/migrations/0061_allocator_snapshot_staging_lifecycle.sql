-- Atomic allocator snapshot cohort publication.
-- Rows are written to staging first; only a complete verified run is copied
-- into the canonical allocator_ev_feature_snapshots table.

CREATE TABLE IF NOT EXISTS allocator_ev_snapshot_runs (
  run_id TEXT PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  snapshot_source TEXT NOT NULL,
  as_of_guard TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing','ready','failed')),
  expected_rows INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  published_rows INTEGER NOT NULL DEFAULT 0,
  native_lineage_rows INTEGER NOT NULL DEFAULT 0,
  reconstructed_lineage_rows INTEGER NOT NULL DEFAULT 0,
  rejected_lineage_rows INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshot_runs_date_status
  ON allocator_ev_snapshot_runs(snapshot_date DESC, snapshot_source, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_feature_snapshot_staging (
  run_id                      TEXT NOT NULL,
  snapshot_date               TEXT NOT NULL,
  stock_id                    INTEGER NOT NULL,
  symbol                      TEXT NOT NULL,
  forecast_data               TEXT,
  score                       REAL,
  score_components            TEXT,
  alpha_context               TEXT,
  alpha_allocation            TEXT NOT NULL,
  market_heat_expected_return REAL,
  market_segment              TEXT,
  recommendation_lane         TEXT,
  snapshot_source             TEXT NOT NULL,
  l4_model_version            TEXT,
  s12_source                  TEXT,
  as_of_guard                 TEXT NOT NULL,
  source_recommendation_date  TEXT,
  generated_at                TEXT NOT NULL,
  PRIMARY KEY (run_id, stock_id),
  FOREIGN KEY (run_id) REFERENCES allocator_ev_snapshot_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshot_staging_run
  ON allocator_ev_feature_snapshot_staging(run_id, snapshot_date, stock_id);
