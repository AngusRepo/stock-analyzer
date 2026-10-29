-- Wei 10/29 (A2 risk Q3): a momentum-zone percentile compares only snapshots of the same
-- candidate-pool definition. Rows written before this column are NULL until the one-time
-- backfill (tools/momentum_pool_definition_backfill.py, D1 write needs Wei go).
ALTER TABLE screener_momentum_snapshots ADD COLUMN pool_definition TEXT;
CREATE INDEX IF NOT EXISTS idx_momentum_snapshots_pool_date
  ON screener_momentum_snapshots(pool_definition, date DESC);
