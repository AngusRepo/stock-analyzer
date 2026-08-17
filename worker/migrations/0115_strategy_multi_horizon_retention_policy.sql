-- Keep the authoritative legacy control table and the Ops shadow control table
-- identical until the Ops domain is formally cut over.
INSERT INTO data_retention_policies (
  policy_id, domain, dataset_pattern, hot_retention_days, cold_retention_days,
  archive_store, action, hard_reference_protected, version, status, approved_reason
) VALUES (
  'strategy_multi_horizon_outcomes_v1', 'learning',
  'price_horizon_labels_v2,canonical_selection_outcomes_v1', 730, NULL,
  'r2', 'retain', 1, 1, 'active',
  'Three, five, and ten-session point-in-time outcomes support strategy-specific shadow evidence without altering the formal five-session gate'
) ON CONFLICT(policy_id) DO UPDATE SET
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
