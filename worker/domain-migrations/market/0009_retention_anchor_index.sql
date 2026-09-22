CREATE INDEX IF NOT EXISTS idx_fundamental_retention_anchor
ON canonical_fundamental_features(stock_id,source,available_date);

CREATE INDEX IF NOT EXISTS idx_market_retention_release_lookup
ON market_retention_releases_v1(dataset_id,released_at,artifact_id);
