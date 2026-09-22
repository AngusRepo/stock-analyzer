-- Bound cold-history lookup cost by artifact identity instead of scanning all run items.
CREATE INDEX IF NOT EXISTS idx_retention_item_artifact_release
ON data_retention_run_items (
 (CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json,'$.artifact_id') END),
 status,deleted_rows,completed_at
);
CREATE INDEX IF NOT EXISTS idx_artifact_retention_history
ON run_artifacts(domain,schema_version,artifact_id);
