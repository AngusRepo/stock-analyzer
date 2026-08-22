ALTER TABLE strategy_route_backfill_eligibility_v1
  ADD COLUMN rejected_label_rows INTEGER NOT NULL DEFAULT 0;
