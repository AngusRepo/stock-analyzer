-- ─── P1#8: Model Lifecycle State + Events ───────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_model_lifecycle.sql

-- Current lifecycle state (single row, updated weekly)
CREATE TABLE IF NOT EXISTS model_lifecycle_state (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  state_json    TEXT NOT NULL,           -- JSON: per-model {status, weight_mult, accuracy, ...}
  events_json   TEXT,                    -- JSON: events from latest check
  updated_at    TEXT NOT NULL
);

-- Audit trail of all lifecycle events
CREATE TABLE IF NOT EXISTS model_lifecycle_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date    TEXT NOT NULL,
  model_name    TEXT NOT NULL,
  event_type    TEXT NOT NULL,           -- 'status_change' | 'balance_guard'
  from_status   TEXT,                    -- 'active' | 'degraded' | 'shadow'
  to_status     TEXT,
  accuracy_30d  REAL,
  detail        TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_date ON model_lifecycle_events(event_date DESC);
