-- FinLab key-level source execution state.

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

CREATE INDEX IF NOT EXISTS idx_source_key_attempts_target_lane
  ON source_key_attempts(target_date, lane, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_key_attempts_run
  ON source_key_attempts(run_id, lane, field);

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

CREATE INDEX IF NOT EXISTS idx_source_key_report_target_lane
  ON source_key_report(target_date, lane, status);

CREATE INDEX IF NOT EXISTS idx_source_key_report_key_status
  ON source_key_report(target_date, lane, field, status);
