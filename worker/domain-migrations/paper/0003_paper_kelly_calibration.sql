CREATE TABLE IF NOT EXISTS paper_kelly_calibration_runs_v1 (
  run_id TEXT PRIMARY KEY,
  artifact_version TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_maturity','rejected','approved','promoted')),
  confidence_semantic TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
  date_count INTEGER NOT NULL DEFAULT 0 CHECK(date_count >= 0),
  train_dates_json TEXT NOT NULL DEFAULT '[]',
  purge_dates_json TEXT NOT NULL DEFAULT '[]',
  oos_dates_json TEXT NOT NULL DEFAULT '[]',
  source_checksum TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  gates_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_kelly_calibration_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK(method='paper-kelly-pav-v1'),
  knowledge_cutoff_date TEXT NOT NULL,
  trained_through_date TEXT NOT NULL,
  confidence_semantic TEXT NOT NULL,
  bins_json TEXT NOT NULL,
  average_win_return REAL NOT NULL CHECK(average_win_return > 0),
  average_loss_return REAL NOT NULL CHECK(average_loss_return > 0),
  fractional_kelly REAL NOT NULL CHECK(fractional_kelly > 0 AND fractional_kelly <= 1),
  max_kelly_pct REAL NOT NULL CHECK(max_kelly_pct > 0 AND max_kelly_pct <= 0.15),
  source_checksum TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES paper_kelly_calibration_runs_v1(run_id)
);

CREATE TABLE IF NOT EXISTS paper_kelly_calibration_head_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES paper_kelly_calibration_runs_v1(run_id),
  FOREIGN KEY(artifact_id) REFERENCES paper_kelly_calibration_artifacts_v1(artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_kelly_calibration_runs_date
  ON paper_kelly_calibration_runs_v1(knowledge_cutoff_date DESC, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_kelly_calibration_artifacts_run
  ON paper_kelly_calibration_artifacts_v1(run_id, trained_through_date DESC);
