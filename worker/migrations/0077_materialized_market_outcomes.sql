-- Replace repeated full-history LEAD/LAG scans with bounded, point-in-time
-- market-session and five-session outcome projections.

ALTER TABLE market_breadth ADD COLUMN sample_size INTEGER;
ALTER TABLE market_breadth ADD COLUMN limit_down_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_prices_date_stock
  ON stock_prices(date, stock_id);

CREATE TABLE IF NOT EXISTS market_trading_sessions (
  session_date TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  materialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(sample_size > 0)
);

CREATE TABLE IF NOT EXISTS price_horizon_labels_v1 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_raw_open REAL NOT NULL,
  entry_adjustment_factor REAL NOT NULL,
  exit_date TEXT NOT NULL,
  exit_raw_close REAL NOT NULL,
  exit_adjustment_factor REAL NOT NULL,
  outcome_known_date TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  materialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date),
  CHECK(entry_date > price_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date),
  CHECK(entry_raw_open > 0),
  CHECK(exit_raw_close > 0),
  CHECK(entry_adjustment_factor > 0),
  CHECK(exit_adjustment_factor > 0)
);
CREATE INDEX IF NOT EXISTS idx_price_horizon_labels_date
  ON price_horizon_labels_v1(price_date, stock_id);
CREATE INDEX IF NOT EXISTS idx_price_horizon_labels_outcome
  ON price_horizon_labels_v1(outcome_known_date, price_date);

CREATE TABLE IF NOT EXISTS price_horizon_label_rejections_v1 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date)
);
CREATE INDEX IF NOT EXISTS idx_price_horizon_rejections_date
  ON price_horizon_label_rejections_v1(price_date, rejection_reason);

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

INSERT INTO data_retention_policies (
  policy_id, domain, dataset_pattern, hot_retention_days, cold_retention_days,
  archive_store, action, hard_reference_protected, version, status, approved_reason
) VALUES
  (
    'market_sessions_hot_v1', 'market', 'market_trading_sessions', 730, 3650,
    'r2', 'archive_delete', 1, 1, 'active',
    'Observed exchange sessions remain hot for point-in-time joins and retain a ten-year cold copy'
  ),
  (
    'price_horizon_learning_v1', 'learning', 'price_horizon_labels_v1,price_horizon_projection_status', 730, NULL,
    'r2', 'retain', 1, 1, 'active',
    'Executable five-session labels remain protected while referenced by active or champion artifacts'
  ),
  (
    'price_horizon_rejections_v1', 'learning', 'price_horizon_label_rejections_v1', 90, 730,
    'r2', 'archive_delete', 1, 1, 'active',
    'Missing price evidence is retained hot for repair and cold for lineage audit'
  ),
  (
    'price_horizon_ops_v1', 'ops', 'price_horizon_projection_runs', 504, 1825,
    'r2', 'archive_delete', 1, 1, 'active',
    'Projection run summaries remain available for lifecycle and SLA audits'
  )
ON CONFLICT(policy_id) DO UPDATE SET
  domain=excluded.domain,
  dataset_pattern=excluded.dataset_pattern,
  hot_retention_days=excluded.hot_retention_days,
  cold_retention_days=excluded.cold_retention_days,
  archive_store=excluded.archive_store,
  action=excluded.action,
  hard_reference_protected=excluded.hard_reference_protected,
  version=excluded.version,
  status=excluded.status,
  approved_reason=excluded.approved_reason,
  updated_at=CURRENT_TIMESTAMP;
