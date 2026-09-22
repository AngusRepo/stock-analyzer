
CREATE INDEX IF NOT EXISTS idx_research_retention_release_lookup
ON research_retention_releases_v1(dataset_id,released_at,artifact_id);
