-- Persist the complete date classification for frozen-forward monitoring.
-- Missing decision-time PIT inputs are non-evaluable, never reconstructed.

ALTER TABLE active8_oof_forward_extension_coverage
  ADD COLUMN expected_date_count INTEGER NOT NULL DEFAULT 0 CHECK(expected_date_count >= 0);

ALTER TABLE active8_oof_forward_extension_coverage
  ADD COLUMN not_evaluable_date_count INTEGER NOT NULL DEFAULT 0 CHECK(not_evaluable_date_count >= 0);

ALTER TABLE active8_oof_forward_extension_coverage
  ADD COLUMN date_eligibility_json TEXT NOT NULL DEFAULT '{}';
