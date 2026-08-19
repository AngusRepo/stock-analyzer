DROP INDEX IF EXISTS idx_strategy_evidence_metrics_v1_status;
DROP INDEX IF EXISTS idx_strategy_evidence_metrics_v1_strategy;

ALTER TABLE strategy_evidence_metrics_v1 RENAME TO strategy_evidence_metrics_v1_legacy_identity;

CREATE TABLE strategy_evidence_metrics_v1 (
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
  PRIMARY KEY(strategy_id, strategy_version, primary_horizon_days, metric_name, outcome_as_of_date)
);

INSERT INTO strategy_evidence_metrics_v1 (
  strategy_id, strategy_version, strategy_status, alpha_bucket, primary_horizon_days,
  metric_name, metric_value, metric_status, sample_count, mature_dates, date_start, date_end,
  outcome_as_of_date, definition_version, evidence_json, updated_at
)
SELECT
  strategy_id, strategy_version, strategy_status, alpha_bucket, primary_horizon_days,
  metric_name, metric_value, metric_status, sample_count, mature_dates, date_start, date_end,
  outcome_as_of_date, definition_version, evidence_json, updated_at
FROM strategy_evidence_metrics_v1_legacy_identity;

DROP TABLE strategy_evidence_metrics_v1_legacy_identity;

CREATE INDEX idx_strategy_evidence_metrics_v1_status
  ON strategy_evidence_metrics_v1(metric_status, metric_name, outcome_as_of_date DESC);

CREATE INDEX idx_strategy_evidence_metrics_v1_strategy
  ON strategy_evidence_metrics_v1(strategy_id, strategy_version, outcome_as_of_date DESC);
