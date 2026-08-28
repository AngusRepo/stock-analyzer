CREATE TABLE IF NOT EXISTS strategy_evidence_metric_snapshot_runs_v1 (
  snapshot_run_id TEXT PRIMARY KEY,
  outcome_as_of_date TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('authority_bridge','learning_target')),
  materialization_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status = 'ready'),
  profile_count INTEGER NOT NULL CHECK(profile_count >= 0),
  observation_count INTEGER NOT NULL CHECK(observation_count >= 0),
  metric_row_count INTEGER NOT NULL CHECK(metric_row_count >= 0),
  ready_row_count INTEGER NOT NULL CHECK(ready_row_count >= 0),
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(outcome_as_of_date, definition_version, source_mode)
);

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_metric_snapshot_runs_date
  ON strategy_evidence_metric_snapshot_runs_v1(
    outcome_as_of_date DESC, definition_version, source_mode, status
  );

ALTER TABLE strategy_evidence_owner_calibration_head_v1
  ADD COLUMN knowledge_cutoff_date TEXT;

UPDATE strategy_evidence_owner_calibration_head_v1
   SET knowledge_cutoff_date=(
     SELECT r.knowledge_cutoff_date
       FROM strategy_evidence_owner_calibration_runs_v1 r
      WHERE r.run_id=strategy_evidence_owner_calibration_head_v1.run_id
   )
 WHERE knowledge_cutoff_date IS NULL;
