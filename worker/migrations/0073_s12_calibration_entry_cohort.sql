ALTER TABLE s12_tw_calibration_artifacts
  ADD COLUMN entry_cohort TEXT NOT NULL DEFAULT 'legacy_mixed';

CREATE INDEX IF NOT EXISTS idx_s12_tw_calibration_entry_cohort
  ON s12_tw_calibration_artifacts(
    status, superseded_at, entry_cohort, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC
  );
