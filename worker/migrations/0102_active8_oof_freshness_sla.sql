CREATE TABLE IF NOT EXISTS active8_oof_freshness_sla (
  decision_key TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  run_id TEXT,
  attempt_id TEXT,
  run_date TEXT,
  cadence TEXT,
  status TEXT NOT NULL CHECK(status IN ('fresh', 'failed', 'missing')),
  reason TEXT NOT NULL,
  expected_max_date TEXT,
  effective_max_date TEXT,
  cohort_id TEXT,
  prep_manifest_checksum TEXT,
  callback_status TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_freshness_sla_status_date
  ON active8_oof_freshness_sla(status, run_date, observed_at);

CREATE INDEX IF NOT EXISTS idx_active8_oof_freshness_sla_task_date
  ON active8_oof_freshness_sla(task, run_date, observed_at);
