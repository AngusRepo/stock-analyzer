-- Durable daily lineage -> snapshot -> five-session replay lifecycle.
CREATE TABLE IF NOT EXISTS allocator_ev_daily_lifecycle (
  business_date TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  native_lineage_rows INTEGER NOT NULL DEFAULT 0,
  snapshot_run_id TEXT,
  snapshot_rows INTEGER NOT NULL DEFAULT 0,
  replay_rows INTEGER NOT NULL DEFAULT 0,
  replay_maturity_as_of_date TEXT,
  upstream_run_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_daily_lifecycle_state_date
  ON allocator_ev_daily_lifecycle(state, business_date);
