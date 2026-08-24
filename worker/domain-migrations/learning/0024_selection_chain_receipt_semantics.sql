-- Explicit end-to-end selection receipts.
-- Legacy ml_selected/l4_selected columns historically meant evaluated/available;
-- keep them for read compatibility, but new attribution must use these exact fields.
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN ml_evaluated INTEGER NOT NULL DEFAULT 0 CHECK(ml_evaluated IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN l4_feature_available INTEGER NOT NULL DEFAULT 0 CHECK(l4_feature_available IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN l4_production_eligible INTEGER NOT NULL DEFAULT 0 CHECK(l4_production_eligible IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN fusion_feature_available INTEGER NOT NULL DEFAULT 0 CHECK(fusion_feature_available IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN primary_expected_return_available INTEGER NOT NULL DEFAULT 0 CHECK(primary_expected_return_available IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN pending_buy_eligible INTEGER NOT NULL DEFAULT 0 CHECK(pending_buy_eligible IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN pending_buy_candidate INTEGER NOT NULL DEFAULT 0 CHECK(pending_buy_candidate IN (0, 1));
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN selection_chain_contract_version TEXT;
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN selection_chain_receipt_json TEXT;

CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_chain_stage
  ON selection_reference_snapshots_v1(signal_date, selection_stage, pending_buy_candidate);
