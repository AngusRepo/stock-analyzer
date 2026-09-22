-- These data are part of the ten-year archive contract; shorter debug classes
-- must not expire their only verified historical copies.
UPDATE data_retention_policies
SET cold_retention_days=3650, version=version+1, updated_at=CURRENT_TIMESTAMP
WHERE policy_id IN ('canonical_market_hot_v1','execution_ledger_v1','learning_lineage_v1',
 'legacy_hot_r2_v1','market_sessions_hot_v1','oof_lineage_cold_archive_v2',
 'price_horizon_ops_v1','price_horizon_rejections_v1','research_runs_v1')
 AND (cold_retention_days IS NULL OR cold_retention_days<3650);
