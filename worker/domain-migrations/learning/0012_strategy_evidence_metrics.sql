CREATE TABLE IF NOT EXISTS strategy_evidence_metrics_v1 (
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  strategy_status TEXT NOT NULL,
  alpha_bucket TEXT NOT NULL,
  primary_horizon_days INTEGER NOT NULL CHECK(primary_horizon_days IN (3,5,10)),
  metric_name TEXT NOT NULL,
  metric_value REAL,
  metric_status TEXT NOT NULL CHECK(metric_status IN (
    'ready','insufficient_samples','dependency_pending','not_available'
  )),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
  mature_dates INTEGER NOT NULL DEFAULT 0 CHECK(mature_dates >= 0),
  date_start TEXT,
  date_end TEXT,
  outcome_as_of_date TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_id, strategy_version, primary_horizon_days, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_metrics_v1_status
  ON strategy_evidence_metrics_v1(metric_status, metric_name, outcome_as_of_date DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_metrics_v1_strategy
  ON strategy_evidence_metrics_v1(strategy_id, strategy_version, outcome_as_of_date DESC);
