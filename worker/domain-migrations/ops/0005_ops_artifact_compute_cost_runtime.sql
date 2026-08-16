-- OPS cutover closure for artifact lifecycle, canonical run state, compute
-- telemetry, and cost tracking. These tables are routed by active production
-- code and therefore must exist and reach authoritative parity before OPS
-- activation.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY,
  logical_run_key TEXT NOT NULL,
  domain TEXT NOT NULL,
  business_date TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'TW',
  mode TEXT NOT NULL DEFAULT 'production',
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'writing','validating','ready','canonical','superseded','failed','reused'
  )),
  input_fingerprint TEXT NOT NULL,
  code_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  artifact_id TEXT,
  supersedes_run_id TEXT,
  reused_from_run_id TEXT,
  parent_run_ids_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  canonical_at TEXT,
  superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_logical_status
  ON pipeline_runs(logical_run_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_fingerprint
  ON pipeline_runs(logical_run_key, input_fingerprint, code_version, config_version);

CREATE TABLE IF NOT EXISTS canonical_run_heads (
  logical_run_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  previous_run_id TEXT,
  promoted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  artifact_id TEXT PRIMARY KEY,
  retention_class TEXT NOT NULL CHECK(retention_class IN (
    'canonical_execution','canonical_model_evidence','paper_shadow',
    'superseded_run','failed_debug','request_debug','raw_market_unreferenced',
    'staging_orphan','incident_pinned'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'writing','validating','ready','integrity_blocked','payload_deleted'
  )),
  domain TEXT NOT NULL,
  business_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  canonical_run_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  retain_until TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  hard_ref_count INTEGER NOT NULL DEFAULT 0,
  checksum_verified_at TEXT,
  payload_deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_retention
  ON run_artifacts(status, retain_until, pinned, legal_hold, hard_ref_count);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_producer
  ON run_artifacts(producer_run_id, domain, business_date);

CREATE TABLE IF NOT EXISTS artifact_cleanup_cursors (
  task TEXT PRIMARY KEY,
  cursor_value TEXT,
  status TEXT NOT NULL CHECK(status IN ('idle','running','failed','complete')),
  processed_rows INTEGER NOT NULL DEFAULT 0,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artifact_cleanup_dlq (
  dlq_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  artifact_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','resolved','blocked')),
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_artifact_cleanup_dlq_status
  ON artifact_cleanup_dlq(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS compute_profile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date TEXT NOT NULL,
  provider TEXT NOT NULL,
  job_name TEXT NOT NULL,
  run_id TEXT,
  wall_sec REAL,
  compute_sec REAL,
  cpu REAL,
  memory_mb INTEGER,
  gpu TEXT,
  est_usd REAL,
  rows INTEGER,
  features INTEGER,
  symbols INTEGER,
  trials INTEGER,
  cache_hit_ratio REAL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_compute_profile_events_job_date
  ON compute_profile_events(job_name, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_compute_profile_events_provider_date
  ON compute_profile_events(provider, event_date DESC);

CREATE TABLE IF NOT EXISTS compute_efficiency_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  job_name TEXT NOT NULL,
  decision TEXT NOT NULL,
  baseline_profile_json TEXT,
  optimized_profile_json TEXT,
  quality_json TEXT,
  efficiency_json TEXT,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_compute_efficiency_reports_job_date
  ON compute_efficiency_reports(job_name, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_compute_efficiency_reports_decision
  ON compute_efficiency_reports(decision, report_date DESC);

CREATE TABLE IF NOT EXISTS cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  compute_sec REAL,
  est_usd REAL NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_events_date ON cost_events(date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_source ON cost_events(source, date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_provider ON cost_events(provider, date DESC);

CREATE VIEW IF NOT EXISTS cost_daily AS
  SELECT date, source, provider, model,
         COUNT(*) AS calls,
         SUM(COALESCE(tokens_in, 0)) AS tokens_in_total,
         SUM(COALESCE(tokens_out, 0)) AS tokens_out_total,
         SUM(COALESCE(compute_sec, 0)) AS compute_sec_total,
         ROUND(SUM(est_usd), 4) AS est_usd_total
    FROM cost_events
   GROUP BY date, source, provider, model;
