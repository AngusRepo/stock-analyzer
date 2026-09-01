ALTER TABLE strategy_evidence_rebuild_runs_v5
  ADD COLUMN producer_run_id TEXT;

ALTER TABLE strategy_evidence_rebuild_runs_v5
  ADD COLUMN source_reference_contract_version TEXT;

ALTER TABLE strategy_evidence_rebuild_runs_v5
  ADD COLUMN production_policy_id TEXT;

ALTER TABLE strategy_evidence_rebuild_runs_v5
  ADD COLUMN production_policy_knowledge_cutoff_date TEXT;

ALTER TABLE strategy_evidence_rebuild_runs_v5
  ADD COLUMN production_policy_checksum TEXT;

ALTER TABLE strategy_evidence_rebuild_runs_v5
  ADD COLUMN production_policy_source_contract TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_rebuild_v5_producer
  ON strategy_evidence_rebuild_runs_v5(signal_date, producer_run_id, status);
