-- Generated from schema.sql; do not edit by hand.
CREATE TABLE IF NOT EXISTS system_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level       TEXT NOT NULL DEFAULT 'info',
  cron_name   TEXT NOT NULL,
  message     TEXT NOT NULL,
  meta        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_system_logs ON system_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS observability_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK(severity IN ('ok','info','warn','error')),
  domain      TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  impact      TEXT,
  next_action TEXT,
  evidence    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observability_events_date ON observability_events(date, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_observability_events_domain ON observability_events(domain, created_at DESC);

CREATE TABLE IF NOT EXISTS sector_flow_pit_rebuild_runs_v1 (
  run_id TEXT PRIMARY KEY,
  signal_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'pass', 'blocked', 'failed')),
  reconstruction_mode TEXT NOT NULL CHECK(reconstruction_mode IN ('native', 'historical_reconstruction')),
  taxonomy_snapshot_ids_json TEXT NOT NULL,
  membership_checksums_json TEXT NOT NULL,
  rows_written INTEGER NOT NULL DEFAULT 0,
  blocker_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sector_flow_pit_rebuild_runs_v1_date
  ON sector_flow_pit_rebuild_runs_v1(signal_date, status, started_at DESC);

CREATE TABLE IF NOT EXISTS screener_funnel_runs (
  run_id          TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'success',
  universe_count  INTEGER DEFAULT 0,
  candidate_count INTEGER DEFAULT 0,
  final_count     INTEGER DEFAULT 0,
  emerging_count  INTEGER DEFAULT 0,
  metadata        TEXT,
  debug_log       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_runs_date ON screener_funnel_runs(date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS screener_funnel_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  date          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  name          TEXT,
  stage         TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason_code   TEXT NOT NULL,
  score_before  REAL,
  score_after   REAL,
  rank          INTEGER,
  evidence      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(run_id) REFERENCES screener_funnel_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_run ON screener_funnel_items(run_id, stage, decision);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_symbol ON screener_funnel_items(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_date_id ON screener_funnel_items(date, id);

CREATE TABLE IF NOT EXISTS pipeline_stage_runs (
  business_date TEXT NOT NULL,
  stage TEXT NOT NULL,
  canonical_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'success', 'error')),
  cursor_key TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  expected_count INTEGER,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(business_date, stage)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stage_runs_status
  ON pipeline_stage_runs(stage, status, business_date DESC);

CREATE TABLE IF NOT EXISTS strategy_learning_runs (
  business_date TEXT PRIMARY KEY,
  canonical_run_id TEXT NOT NULL,
  producer_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'error')),
  cursor_symbol TEXT,
  expected_candidates INTEGER,
  processed_candidates INTEGER NOT NULL DEFAULT 0,
  strategy_count INTEGER,
  expected_decision_rows INTEGER,
  persisted_decision_rows INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_strategy_learning_runs_status
  ON strategy_learning_runs(status, business_date DESC);

CREATE TABLE IF NOT EXISTS maintenance_task_leases (
  lease_group TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS legacy_migration_cursors (
  task_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error')),
  cursor_date TEXT,
  cursor_key TEXT,
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_key   TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  run_date   TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduler_locks_owner_date
  ON scheduler_locks(owner, run_date, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_hard_references (
  reference_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_type, owner_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_hard_references_artifact_active
  ON artifact_hard_references(artifact_id, active);

CREATE INDEX IF NOT EXISTS idx_artifact_hard_references_owner_active
  ON artifact_hard_references(owner_type, owner_id, active);

CREATE TABLE IF NOT EXISTS domain_projection_outbox (
  event_id TEXT PRIMARY KEY,
  source_domain TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  business_date TEXT,
  payload_json TEXT,
  payload_artifact_id TEXT,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'publishing', 'published', 'error')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_domain_projection_outbox_pending
  ON domain_projection_outbox(status, available_at, source_domain, target_domain);

CREATE TABLE IF NOT EXISTS domain_projection_inbox (
  target_domain TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(target_domain, event_id)
);

CREATE TABLE IF NOT EXISTS data_domain_cutovers (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('legacy', 'shadow', 'read_cutover', 'write_cutover', 'complete', 'rollback')),
  source_binding TEXT NOT NULL DEFAULT 'DB',
  target_binding TEXT,
  source_row_count INTEGER,
  target_row_count INTEGER,
  source_checksum TEXT,
  target_checksum TEXT,
  parity_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_retention_policies (
  policy_id TEXT PRIMARY KEY, domain TEXT NOT NULL, dataset_pattern TEXT NOT NULL,
  hot_retention_days INTEGER NOT NULL, cold_retention_days INTEGER,
  archive_store TEXT NOT NULL CHECK(archive_store IN ('r2', 'gcs', 'none')),
  action TEXT NOT NULL CHECK(action IN ('archive_scrub', 'archive_delete', 'delete_unreferenced', 'retain')),
  hard_reference_protected INTEGER NOT NULL DEFAULT 1 CHECK(hard_reference_protected IN (0, 1)),
  version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'retired')),
  approved_reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_retention_runs (
  run_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped')),
  scanned_rows INTEGER NOT NULL DEFAULT 0, archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0, deleted_rows INTEGER NOT NULL DEFAULT 0,
  archived_bytes INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT,
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);

CREATE INDEX IF NOT EXISTS idx_data_retention_runs_policy_date
  ON data_retention_runs(policy_id, business_date DESC, status);

CREATE TABLE IF NOT EXISTS storage_capacity_daily (
  observed_date TEXT NOT NULL, domain TEXT NOT NULL, binding_name TEXT NOT NULL,
  used_bytes INTEGER NOT NULL, max_bytes INTEGER NOT NULL, utilization_pct REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'warning', 'drain', 'critical')),
  measurement_source TEXT NOT NULL CHECK(measurement_source = 'd1_result_meta_size_after'),
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(observed_date, domain, binding_name)
);

INSERT OR IGNORE INTO data_retention_policies VALUES
  ('audit_json_r2_v1', 'ops', 'strategy_decision_log,screener_funnel_items,paper_execution_events', 90, 2555, 'r2', 'archive_scrub', 1, 1, 'active', 'Preserve scalar learning/execution rows; move large verified JSON to R2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('legacy_hot_r2_v1', 'ops', 'obsolete_screener,superseded_pending,null_date_predictions,intraday_manifests,state_space_shadow,staging_orphans', 30, 730, 'r2', 'archive_delete', 1, 1, 'active', 'Only obsolete or superseded cohorts may be deleted after checksum-verified archive', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('canonical_market_hot_v1', 'market', 'canonical_market_and_fundamental_pit', 504, 3650, 'r2', 'archive_delete', 1, 1, 'active', '504-day hot PIT window; active artifact hard references block retirement', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('learning_lineage_v1', 'learning', 'predictions,labels,replay,snapshots,oof', 730, 3650, 'r2', 'archive_delete', 1, 1, 'active', 'Keep two years hot; active/champion hard references block archive deletion; retain ten-year verified cold lineage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('execution_ledger_v1', 'execution', 'orders,fills,positions,reconciliation,execution_events', 730, 3650, 'r2', 'archive_delete', 1, 1, 'active', 'Keep two years hot and preserve checksum-verified execution evidence for ten years in cold storage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('research_runs_v1', 'research', 'backtests,optuna,pbo,discovery', 180, 1825, 'r2', 'archive_delete', 1, 1, 'active', 'Bounded research hot store with five-year reproducibility archive', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS price_horizon_projection_status (
  signal_date TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  materialized_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'incomplete', 'empty')),
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(candidate_count >= 0),
  CHECK(materialized_count >= 0),
  CHECK(rejected_count >= 0),
  CHECK(materialized_count + rejected_count = candidate_count)
);

CREATE TABLE IF NOT EXISTS price_horizon_projection_runs (
  run_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  outcome_as_of_date TEXT NOT NULL,
  eligible_signal_dates INTEGER NOT NULL DEFAULT 0,
  processed_signal_dates INTEGER NOT NULL DEFAULT 0,
  skipped_complete_dates INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  materialized_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'complete_with_rejections', 'error')),
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

INSERT OR IGNORE INTO data_retention_policies VALUES
  ('market_sessions_hot_v1', 'market', 'market_trading_sessions', 730, 3650, 'r2', 'archive_delete', 1, 1, 'active', 'Observed exchange sessions remain hot for point-in-time joins and retain a ten-year cold copy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('price_horizon_learning_v1', 'learning', 'price_horizon_labels_v1,price_horizon_projection_status', 730, NULL, 'r2', 'retain', 1, 1, 'active', 'Executable five-session labels remain protected while referenced by active or champion artifacts', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('price_horizon_rejections_v1', 'learning', 'price_horizon_label_rejections_v1', 90, 730, 'r2', 'archive_delete', 1, 1, 'active', 'Missing price evidence is retained hot for repair and cold for lineage audit', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('price_horizon_ops_v1', 'ops', 'price_horizon_projection_runs', 504, 1825, 'r2', 'archive_delete', 1, 1, 'active', 'Projection run summaries remain available for lifecycle and SLA audits', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS data_domain_backfill_cursors (
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','error')),
  cursor_json TEXT,
  rows_copied INTEGER NOT NULL DEFAULT 0,
  last_batch_rows INTEGER NOT NULL DEFAULT 0,
  last_source_checksum TEXT,
  last_target_checksum TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(domain, table_name)
);

CREATE INDEX IF NOT EXISTS idx_data_domain_backfill_status
  ON data_domain_backfill_cursors(status, domain, updated_at);

CREATE TABLE IF NOT EXISTS data_domain_parity_checks (
  check_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','blocked')),
  source_count INTEGER,
  target_count INTEGER,
  source_checksum TEXT,
  target_checksum TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_data_domain_parity_latest
  ON data_domain_parity_checks(domain, table_name, checked_at DESC);
