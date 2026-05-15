CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_key   TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  run_date   TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduler_locks_owner_date
  ON scheduler_locks(owner, run_date, created_at DESC);
