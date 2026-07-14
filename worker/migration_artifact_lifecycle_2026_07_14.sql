-- R2-first evidence ownership and canonical rerun registry.
-- Apply as an incremental migration; do not re-run the full schema.sql in production.

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
CREATE INDEX IF NOT EXISTS idx_artifact_d1_scrub_queue_status
  ON artifact_d1_scrub_queue(status, next_attempt_at, created_at);

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

CREATE TABLE IF NOT EXISTS strategy_candidate_contexts (
  context_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  raw_signals_json TEXT NOT NULL DEFAULT '{}',
  current_price REAL,
  industry TEXT,
  artifact_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, context_hash)
);
CREATE INDEX IF NOT EXISTS idx_strategy_candidate_contexts_date_symbol
  ON strategy_candidate_contexts(date DESC, symbol);

ALTER TABLE strategy_decision_log ADD COLUMN context_id TEXT;
ALTER TABLE strategy_decision_log ADD COLUMN evidence_artifact_id TEXT;
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_context
  ON strategy_decision_log(context_id);
