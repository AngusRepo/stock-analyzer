CREATE TABLE IF NOT EXISTS price_horizon_projection_status_v2 (
  signal_date TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK(horizon_days IN (3,5,10)),
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  materialized_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','incomplete','empty')),
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, horizon_days),
  CHECK(candidate_count >= 0),
  CHECK(materialized_count >= 0),
  CHECK(rejected_count >= 0),
  CHECK(materialized_count + rejected_count = candidate_count)
);
CREATE INDEX IF NOT EXISTS idx_price_horizon_projection_status_v2_updated
  ON price_horizon_projection_status_v2(horizon_days, status, updated_at);

INSERT INTO data_retention_policies (
  policy_id, domain, dataset_pattern, hot_retention_days, cold_retention_days,
  archive_store, action, hard_reference_protected, version, status, approved_reason
) VALUES (
  'strategy_multi_horizon_outcomes_v1', 'learning',
  'price_horizon_labels_v2,canonical_selection_outcomes_v1', 730, NULL,
  'r2', 'retain', 1, 1, 'active',
  'Three, five, and ten-session point-in-time outcomes support strategy-specific shadow evidence without altering the formal five-session gate'
) ON CONFLICT(policy_id) DO UPDATE SET
  dataset_pattern=excluded.dataset_pattern, version=excluded.version,
  status=excluded.status, approved_reason=excluded.approved_reason,
  updated_at=CURRENT_TIMESTAMP;
