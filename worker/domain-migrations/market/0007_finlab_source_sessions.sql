-- Independent source observations, never inferred from successfully projected prices.
CREATE TABLE IF NOT EXISTS finlab_source_sessions_v1 (
  session_date TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  positive_close_count INTEGER NOT NULL CHECK(positive_close_count>=100),
  source_checksum TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finlab_source_sessions_date
  ON finlab_source_sessions_v1(session_date);
CREATE TRIGGER IF NOT EXISTS finlab_source_session_no_update
BEFORE UPDATE ON finlab_source_sessions_v1 BEGIN
  SELECT RAISE(ABORT, 'finlab_source_session_immutable');
END;
