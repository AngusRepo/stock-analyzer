-- V4.1 compute profile observability.
-- Run only after Wei approval:
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_compute_profile_events.sql

CREATE TABLE IF NOT EXISTS compute_profile_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  job_name        TEXT NOT NULL,
  run_id          TEXT,
  wall_sec        REAL,
  compute_sec     REAL,
  await_sec       REAL,
  compute_owner   TEXT,
  remote_function TEXT,
  cpu             REAL,
  memory_mb       INTEGER,
  gpu             TEXT,
  est_usd         REAL,
  rows            INTEGER,
  features        INTEGER,
  symbols         INTEGER,
  trials          INTEGER,
  cache_hit_ratio REAL,
  profile_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_profile_events_job_date
  ON compute_profile_events(job_name, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_compute_profile_events_provider_date
  ON compute_profile_events(provider, event_date DESC);

CREATE TABLE IF NOT EXISTS compute_efficiency_reports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date             TEXT NOT NULL,
  job_name                TEXT NOT NULL,
  decision                TEXT NOT NULL,
  baseline_profile_json   TEXT,
  optimized_profile_json  TEXT,
  quality_json            TEXT,
  efficiency_json         TEXT,
  report_json             TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_efficiency_reports_job_date
  ON compute_efficiency_reports(job_name, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_compute_efficiency_reports_decision
  ON compute_efficiency_reports(decision, report_date DESC);
