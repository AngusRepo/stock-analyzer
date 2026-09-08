-- Existing v1 receipts and values remain untouched. New runs publish immutable revisions.
CREATE TABLE IF NOT EXISTS strategy_evidence_metric_snapshot_runs_v2 (
 snapshot_run_id TEXT PRIMARY KEY,
 outcome_as_of_date TEXT NOT NULL,
 definition_version TEXT NOT NULL,
 source_mode TEXT NOT NULL CHECK(source_mode IN ('authority_bridge','learning_target')),
 publication_scope TEXT NOT NULL,
 materialization_source TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status='ready'),
 profile_count INTEGER NOT NULL,
 observation_count INTEGER NOT NULL,
 metric_row_count INTEGER NOT NULL,
 ready_row_count INTEGER NOT NULL,
 payload_checksum TEXT NOT NULL CHECK(length(payload_checksum)=64),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(outcome_as_of_date,definition_version,source_mode,publication_scope)
);
CREATE TABLE IF NOT EXISTS strategy_evidence_metric_snapshot_rows_v2 (
 snapshot_run_id TEXT NOT NULL REFERENCES strategy_evidence_metric_snapshot_runs_v2(snapshot_run_id),
 row_index INTEGER NOT NULL,
 row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 PRIMARY KEY(snapshot_run_id,row_index)
);
