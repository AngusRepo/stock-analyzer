CREATE TABLE IF NOT EXISTS s12_tw_calibration_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  cadence TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes_seen INTEGER NOT NULL DEFAULT 0,
  artifacts_written INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS s12_tw_calibration_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cadence TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  alpha_bucket TEXT,
  entry_time_bucket TEXT,
  policy_json TEXT NOT NULL,
  exit_json TEXT NOT NULL,
  validation_start TEXT NOT NULL,
  validation_end TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  date_count INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  superseded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_s12_tw_calibration_active
  ON s12_tw_calibration_artifacts(status, superseded_at, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC);
