-- Add runtime-owned tables deferred from the immutable domain baseline.
INSERT INTO data_domain_cutovers(domain, status, source_binding, target_binding)
VALUES
  ('core', 'legacy', 'DB', 'CORE_DB'),
  ('market', 'legacy', 'DB', 'MARKET_DB'),
  ('learning', 'legacy', 'DB', 'LEARNING_DB'),
  ('ops', 'legacy', 'DB', 'OPS_DB'),
  ('execution', 'legacy', 'DB', 'EXECUTION_DB'),
  ('paper', 'legacy', 'DB', 'PAPER_DB'),
  ('research', 'legacy', 'DB', 'RESEARCH_DB')
ON CONFLICT(domain) DO NOTHING;

CREATE TABLE IF NOT EXISTS weekly_audit_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date   TEXT NOT NULL UNIQUE,
  report_text   TEXT NOT NULL,
  l1_json       TEXT,
  l2_json       TEXT,
  l3_json       TEXT,
  risk_json     TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_log (
  idempotency_key TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,
  source          TEXT NOT NULL,
  action          TEXT NOT NULL,
  payload_summary TEXT,
  status          TEXT NOT NULL,
  downstream_notes TEXT
);

CREATE TABLE IF NOT EXISTS finlab_backfill_runs (
  run_id          TEXT PRIMARY KEY,
  generated_at    TEXT NOT NULL,
  lookback_years  INTEGER NOT NULL DEFAULT 5,
  dataset_count   INTEGER NOT NULL DEFAULT 0,
  finlab_rows     INTEGER NOT NULL DEFAULT 0,
  gap_fill_rows   INTEGER NOT NULL DEFAULT 0,
  value_conflicts INTEGER NOT NULL DEFAULT 0,
  checksum        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready',
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_diff_report (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  dataset_lane           TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'finlab',
  generated_at           TEXT NOT NULL,
  finlab_rows            INTEGER NOT NULL DEFAULT 0,
  stockvision_rows       INTEGER NOT NULL DEFAULT 0,
  matched_rows           INTEGER NOT NULL DEFAULT 0,
  missing_in_stockvision INTEGER NOT NULL DEFAULT 0,
  missing_in_finlab      INTEGER NOT NULL DEFAULT 0,
  value_conflicts        INTEGER NOT NULL DEFAULT 0,
  schema_extra_fields    TEXT,
  report_json            TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gap_fill_candidates (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  dataset_lane           TEXT NOT NULL,
  canonical_table        TEXT NOT NULL,
  stock_id               TEXT,
  symbol                 TEXT,
  date                   TEXT,
  market_segment         TEXT,
  field                  TEXT,
  finlab_value           TEXT,
  stockvision_value      TEXT,
  source                 TEXT NOT NULL DEFAULT 'finlab',
  lineage_json           TEXT NOT NULL,
  decision               TEXT NOT NULL DEFAULT 'candidate',
  generated_at           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_source_inventory (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source                 TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  field                  TEXT NOT NULL,
  stock_id               TEXT,
  market_segment         TEXT,
  date                   TEXT,
  as_of_date             TEXT NOT NULL,
  coverage_status        TEXT NOT NULL,
  freshness_status       TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, dataset, field, stock_id, market_segment, as_of_date)
);

CREATE TABLE IF NOT EXISTS finlab_materialization_manifest (
  run_id                 TEXT PRIMARY KEY,
  generated_at           TEXT NOT NULL,
  source_run_id          TEXT,
  artifact_root          TEXT NOT NULL,
  row_counts_json        TEXT NOT NULL,
  freshness_json         TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ready',
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_key_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  target_date       TEXT NOT NULL,
  lane              TEXT NOT NULL,
  canonical_dataset TEXT,
  field             TEXT NOT NULL,
  api_key           TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'finlab',
  required          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL,
  rows              INTEGER NOT NULL DEFAULT 0,
  target_rows       INTEGER NOT NULL DEFAULT 0,
  latest_date       TEXT,
  artifact_uri      TEXT,
  artifact_path     TEXT,
  artifact_checksum TEXT,
  error_code        TEXT,
  error_message     TEXT,
  generated_at      TEXT NOT NULL,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_key_report (
  target_date       TEXT NOT NULL,
  lane              TEXT NOT NULL,
  field             TEXT NOT NULL,
  api_key           TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'finlab',
  canonical_dataset TEXT,
  required          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL,
  rows              INTEGER NOT NULL DEFAULT 0,
  target_rows       INTEGER NOT NULL DEFAULT 0,
  latest_date       TEXT,
  artifact_uri      TEXT,
  artifact_path     TEXT,
  artifact_checksum TEXT,
  last_run_id       TEXT NOT NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 1,
  error_code        TEXT,
  error_message     TEXT,
  generated_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json     TEXT,
  PRIMARY KEY(target_date, lane, field, api_key)
);

CREATE TABLE IF NOT EXISTS artifact_d1_scrub_queue (
  scrub_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_pk_column TEXT NOT NULL,
  target_pk_value TEXT NOT NULL,
  target_column TEXT NOT NULL,
  replacement_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','running','complete','failed','integrity_blocked'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON webhook_log(received_at);

CREATE INDEX IF NOT EXISTS idx_webhook_log_action   ON webhook_log(action);

CREATE INDEX IF NOT EXISTS idx_source_diff_report_run ON source_diff_report(run_id, dataset_lane);

CREATE INDEX IF NOT EXISTS idx_source_diff_report_lane ON source_diff_report(dataset_lane, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_gap_fill_candidates_run ON gap_fill_candidates(run_id, dataset_lane);

CREATE INDEX IF NOT EXISTS idx_gap_fill_candidates_key ON gap_fill_candidates(stock_id, date, field);

CREATE INDEX IF NOT EXISTS idx_data_source_inventory_dataset ON data_source_inventory(dataset, as_of_date DESC);

CREATE INDEX IF NOT EXISTS idx_source_key_attempts_target_lane
  ON source_key_attempts(target_date, lane, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_key_attempts_run
  ON source_key_attempts(run_id, lane, field);

CREATE INDEX IF NOT EXISTS idx_source_key_report_target_lane
  ON source_key_report(target_date, lane, status);

CREATE INDEX IF NOT EXISTS idx_source_key_report_key_status
  ON source_key_report(target_date, lane, field, status);

CREATE INDEX IF NOT EXISTS idx_artifact_d1_scrub_queue_status
  ON artifact_d1_scrub_queue(status, next_attempt_at, created_at);
