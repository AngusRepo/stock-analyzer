-- Strategy threshold auto-calibration governance.
-- Threshold artifacts are machine-approved by guardrails; StrategySpec base
-- thresholds remain the canonical fallback.

CREATE TABLE IF NOT EXISTS strategy_threshold_calibration_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
  status TEXT NOT NULL CHECK(status IN ('success','partial','skipped','failed')),
  specs_seen INTEGER NOT NULL DEFAULT 0,
  artifacts_written INTEGER NOT NULL DEFAULT 0,
  guardrails_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_threshold_calibration_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  target_key TEXT NOT NULL DEFAULT 'featureRefs.weightedScore.min',
  status TEXT NOT NULL CHECK(status IN ('approved','rejected','frozen','rolled_back')),
  cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
  base_min REAL NOT NULL,
  previous_min REAL,
  calibrated_min REAL NOT NULL,
  delta REAL NOT NULL,
  validation_start TEXT NOT NULL,
  validation_end TEXT NOT NULL,
  guardrails_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  superseded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_strategy_threshold_artifacts_latest
  ON strategy_threshold_calibration_artifacts(strategy_id, strategy_version, target_key, status, approved_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_threshold_artifacts_run
  ON strategy_threshold_calibration_artifacts(run_id, status);
