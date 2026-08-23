-- Immutable execution receipts for every canonical PBO attempt.
CREATE TABLE IF NOT EXISTS pbo_attempt_receipts (
  attempt_id               TEXT PRIMARY KEY,
  run_date                 TEXT NOT NULL,
  source                   TEXT NOT NULL DEFAULT 'backtest',
  status                   TEXT NOT NULL CHECK (status IN ('computed', 'insufficient_evidence')),
  n_partitions             INTEGER NOT NULL CHECK (n_partitions >= 4),
  observed_trades          INTEGER NOT NULL CHECK (observed_trades >= 0),
  required_trades          INTEGER NOT NULL CHECK (required_trades > 0),
  source_provenance_json   TEXT NOT NULL CHECK (json_valid(source_provenance_json)),
  pbo_result_id            INTEGER,
  production_effect        INTEGER NOT NULL DEFAULT 0 CHECK (production_effect = 0),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'insufficient_evidence' AND pbo_result_id IS NULL)
    OR (status = 'computed' AND pbo_result_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pbo_attempt_receipts_latest
  ON pbo_attempt_receipts(run_date DESC, created_at DESC);
