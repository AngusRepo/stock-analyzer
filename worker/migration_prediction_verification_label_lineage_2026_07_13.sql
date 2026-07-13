ALTER TABLE predictions ADD COLUMN verification_label_schema_version TEXT;
ALTER TABLE predictions ADD COLUMN verification_label_entry_price REAL;
ALTER TABLE predictions ADD COLUMN verification_label_end_date TEXT;
ALTER TABLE predictions ADD COLUMN verification_label_known_date TEXT;

CREATE INDEX IF NOT EXISTS idx_predictions_verification_label
  ON predictions(verification_label_schema_version, prediction_date, model_name)
  WHERE verified_at IS NOT NULL;
