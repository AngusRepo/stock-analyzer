-- M2: per-run cell counts on the matrix run header (see src/lib/strategyLabelMatrixRunSummary.ts).
-- Written by the promotion batch and the challenger projection; NULL summary_version means
-- "not summarised" (every run promoted before this migration) and readers count the cells.
-- Must be applied before the Worker that writes these columns is deployed.
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_version TEXT;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_matrix_rows INTEGER;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_contract_rows INTEGER;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_evaluable_rows INTEGER;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_matched_rows INTEGER;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_threshold_evidence_rows INTEGER;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_challenger_projection_rows INTEGER;
ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN summary_projected_threshold_rows INTEGER;
