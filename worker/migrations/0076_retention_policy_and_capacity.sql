CREATE TABLE IF NOT EXISTS data_retention_policies (
  policy_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  dataset_pattern TEXT NOT NULL,
  hot_retention_days INTEGER NOT NULL,
  cold_retention_days INTEGER,
  archive_store TEXT NOT NULL CHECK(archive_store IN ('r2', 'gcs', 'none')),
  action TEXT NOT NULL CHECK(action IN ('archive_scrub', 'archive_delete', 'delete_unreferenced', 'retain')),
  hard_reference_protected INTEGER NOT NULL DEFAULT 1 CHECK(hard_reference_protected IN (0, 1)),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'retired')),
  approved_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_retention_runs (
  run_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped')),
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  archived_bytes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);
CREATE INDEX IF NOT EXISTS idx_data_retention_runs_policy_date
  ON data_retention_runs(policy_id, business_date DESC, status);

CREATE TABLE IF NOT EXISTS storage_capacity_daily (
  observed_date TEXT NOT NULL,
  domain TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  used_bytes INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  utilization_pct REAL NOT NULL,
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
