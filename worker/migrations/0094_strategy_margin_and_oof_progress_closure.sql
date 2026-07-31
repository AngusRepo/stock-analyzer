-- Preserve the actual strategy-hit denominator for reconstructed threshold-margin evidence.
ALTER TABLE strategy_route_backfill_eligibility_v1
  ADD COLUMN matched_matrix_rows INTEGER NOT NULL DEFAULT 0;
