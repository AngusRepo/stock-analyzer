-- Generated from schema.sql plus production snapshot fallback; do not edit by hand.
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

CREATE TABLE IF NOT EXISTS data_domain_writer_epochs (
  domain TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  writer_state TEXT NOT NULL DEFAULT 'open' CHECK(writer_state IN ('open', 'quiescing', 'cutover')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_domain_table_writer_epochs (
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(domain, table_name)
);

CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_receipts (
  receipt_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  source_epoch INTEGER NOT NULL CHECK(source_epoch >= 0),
  parity_checked_at TEXT NOT NULL,
  read_write_readback_passed INTEGER NOT NULL CHECK(read_write_readback_passed IN (0, 1)),
  rollback_restore_passed INTEGER NOT NULL CHECK(rollback_restore_passed IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed')),
  checked_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_data_domain_cutover_probe_latest
  ON data_domain_cutover_probe_receipts(domain, checked_at DESC);

CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_canary (
  probe_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

CREATE TABLE IF NOT EXISTS cost_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  date            TEXT NOT NULL,
  source          TEXT NOT NULL,
  provider        TEXT,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  compute_sec     REAL,
  est_usd         REAL NOT NULL,
  meta            TEXT
);

CREATE TABLE IF NOT EXISTS compute_profile_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  job_name        TEXT NOT NULL,
  run_id          TEXT,
  wall_sec        REAL,
  compute_sec     REAL,
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
, await_sec REAL, compute_owner TEXT, remote_function TEXT);

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

CREATE TABLE IF NOT EXISTS data_retention_cursors (
  policy_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','cycle_complete','error')),
  cursor_date TEXT,
  cursor_key TEXT,
  cycle INTEGER NOT NULL DEFAULT 0,
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  backlog_remaining INTEGER NOT NULL DEFAULT 1 CHECK(backlog_remaining IN (0,1)),
  last_run_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(policy_id, dataset_id),
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);

CREATE TABLE IF NOT EXISTS data_retention_run_items (
  run_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  archived_bytes INTEGER NOT NULL DEFAULT 0,
  cursor_date TEXT,
  cursor_key TEXT,
  backlog_remaining INTEGER NOT NULL DEFAULT 0 CHECK(backlog_remaining IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, dataset_id),
  FOREIGN KEY(run_id) REFERENCES data_retention_runs(run_id)
);

CREATE TABLE IF NOT EXISTS s12_structure_batch_runs (
  run_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('evening_chain','historical_shadow','manual_repair')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  shard_count INTEGER NOT NULL DEFAULT 0,
  completed_shards INTEGER NOT NULL DEFAULT 0,
  artifact_id TEXT,
  artifact_checksum TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(artifact_checksum IS NULL OR artifact_checksum GLOB 'sha256:[0-9a-f]*')
);

CREATE TABLE IF NOT EXISTS s12_structure_batch_shards (
  run_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  first_symbol TEXT,
  last_symbol TEXT,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  attempt INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, shard_index),
  FOREIGN KEY(run_id) REFERENCES s12_structure_batch_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON webhook_log(received_at);

CREATE INDEX IF NOT EXISTS idx_webhook_log_action   ON webhook_log(action);

CREATE INDEX IF NOT EXISTS idx_cost_events_date     ON cost_events(date DESC);

CREATE INDEX IF NOT EXISTS idx_cost_events_source   ON cost_events(source, date DESC);

CREATE INDEX IF NOT EXISTS idx_cost_events_provider ON cost_events(provider, date DESC);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_run_symbol_stage
  ON screener_funnel_items(run_id, symbol, stage, created_at);

CREATE INDEX IF NOT EXISTS idx_compute_profile_events_job_date
  ON compute_profile_events(job_name, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_compute_profile_events_provider_date
  ON compute_profile_events(provider, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_compute_efficiency_reports_job_date
  ON compute_efficiency_reports(job_name, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_compute_efficiency_reports_decision
  ON compute_efficiency_reports(decision, report_date DESC);

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

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_logical_status
  ON pipeline_runs(logical_run_key, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_fingerprint
  ON pipeline_runs(logical_run_key, input_fingerprint, code_version, config_version);

CREATE INDEX IF NOT EXISTS idx_run_artifacts_retention
  ON run_artifacts(status, retain_until, pinned, legal_hold, hard_ref_count);

CREATE INDEX IF NOT EXISTS idx_run_artifacts_producer
  ON run_artifacts(producer_run_id, domain, business_date);

CREATE INDEX IF NOT EXISTS idx_artifact_d1_scrub_queue_status
  ON artifact_d1_scrub_queue(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_artifact_cleanup_dlq_status
  ON artifact_cleanup_dlq(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_data_retention_cursors_backlog
  ON data_retention_cursors(status, backlog_remaining, policy_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_data_retention_run_items_dataset
  ON data_retention_run_items(dataset_id, completed_at DESC, status);

CREATE INDEX IF NOT EXISTS idx_s12_structure_batch_runs_date_status
  ON s12_structure_batch_runs(trade_date DESC, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_s12_structure_batch_shards_status
  ON s12_structure_batch_shards(status, updated_at, run_id, shard_index);
