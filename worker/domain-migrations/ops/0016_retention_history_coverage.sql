-- Filter cold market history by overlapping source dates before transferring manifests.
-- Unknown legacy coverage remains visible and must be verified by the reader.
CREATE INDEX IF NOT EXISTS idx_artifact_retention_coverage
ON run_artifacts(domain,schema_version,
 COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.coverage_end') END,'9999-12-31'),
 COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.coverage_start') END,'0000-01-01'),
 artifact_id)
WHERE retention_class='ten_year_cold_archive' AND status='ready' AND payload_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ops_retention_release_lookup
ON ops_retention_releases_v1(dataset_id,released_at,artifact_id);
