-- Immutable-ready attestation and compare-and-swap owner for selection evidence.
-- Existing ready rows remain readable but cannot be treated as idempotent until
-- they carry a verified payload/artifact attestation.

ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN evidence_artifact_id TEXT;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN payload_checksum TEXT;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN promotion_attempt_id TEXT;
ALTER TABLE selection_evidence_staging_runs_v1 ADD COLUMN payload_checksum TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_runs_v4_payload
  ON strategy_label_matrix_runs_v4(producer_run_id, status, payload_checksum);
