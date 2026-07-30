-- Make canonical reference identity repair observable and keep PIT identity lookups bounded.
CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_date_stock_identity
  ON selection_reference_snapshots_v1(signal_date, hard_gate_passed, stock_id);

CREATE TABLE IF NOT EXISTS selection_reference_identity_repair_runs_v1 (
  run_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error')),
  expected_rows INTEGER NOT NULL,
  missing_before INTEGER NOT NULL,
  repaired_rows INTEGER NOT NULL DEFAULT 0,
  missing_after INTEGER,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_selection_reference_identity_repair_runs_v1_dates
  ON selection_reference_identity_repair_runs_v1(start_date, end_date, status);
