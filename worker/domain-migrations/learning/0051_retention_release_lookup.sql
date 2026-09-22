
CREATE INDEX IF NOT EXISTS idx_learning_retention_release_lookup
ON learning_retention_releases_v1(dataset_id,released_at,artifact_id);
