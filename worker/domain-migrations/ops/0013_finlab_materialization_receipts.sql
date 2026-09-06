CREATE TABLE IF NOT EXISTS finlab_materialization_receipts_v1 (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  data_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count>=0),
  payload_checksum TEXT NOT NULL,
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
  status TEXT NOT NULL CHECK(status='write_acknowledged'),
  persisted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_finlab_materialization_receipts_run
  ON finlab_materialization_receipts_v1(run_id,dataset,data_date,generated_at);
CREATE TRIGGER IF NOT EXISTS finlab_materialization_receipt_no_update
BEFORE UPDATE ON finlab_materialization_receipts_v1 BEGIN
  SELECT RAISE(ABORT, 'finlab_materialization_receipt_immutable');
END;
