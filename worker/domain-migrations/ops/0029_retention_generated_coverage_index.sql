-- L-2: latest-N reads of archived Learning predictions ordered by generated_at
-- (/ml/trade-history, /api/stocks/:id/predictions) page archive manifests by their newest
-- generated_at instead of listing every predictions manifest per request. Index only; no data change.
-- Rollback: DROP INDEX IF EXISTS idx_artifact_retention_generated_coverage;
CREATE INDEX IF NOT EXISTS idx_artifact_retention_generated_coverage
ON run_artifacts(domain,schema_version,
 COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.generated_coverage_end') END,'9999-12-31'),
 artifact_id)
WHERE retention_class='ten_year_cold_archive' AND status='ready' AND payload_deleted_at IS NULL;
