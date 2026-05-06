-- ─── #28b T3.4/T3.5: Config Pool Lifecycle ─────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_config_lifecycle.sql
--
-- Mirrors migration_model_lifecycle.sql pattern but for params (trading:config)
-- rather than ML models. Single active champion (trading:config) vs optional
-- single challenger (trading:config:challenger); weekly Friday cron runs
-- replay-based perf comparison, records here.

-- Current challenger state (single row, updated weekly by config_pool/weekly_eval)
CREATE TABLE IF NOT EXISTS config_lifecycle_state (
  id                        INTEGER PRIMARY KEY DEFAULT 1,
  state_json                TEXT NOT NULL,           -- JSON: {champion_hash, challenger_hash, champion_perf, challenger_perf, consecutive_wins, consecutive_losses, shadow_since, ...}
  last_eval_json            TEXT,                    -- JSON: latest eval result from replay_period
  updated_at                TEXT NOT NULL
);

-- Audit trail of all config lifecycle events (promote / retire / eval_done / alert)
CREATE TABLE IF NOT EXISTS config_lifecycle_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date        TEXT NOT NULL,
  event_type        TEXT NOT NULL,           -- 'challenger_set' | 'eval_done' | 'promote' | 'retire' | 'alert'
  challenger_source TEXT,                    -- 'sandbox' | 'manual' | 'auto' (where challenger came from)
  champion_hash     TEXT,
  challenger_hash   TEXT,
  sharpe_delta      REAL,                    -- challenger_sharpe - champion_sharpe
  win_rate_delta    REAL,
  max_dd_delta      REAL,
  detail            TEXT,                    -- freeform JSON blob with full metrics
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_config_lifecycle_events_date ON config_lifecycle_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_config_lifecycle_events_type ON config_lifecycle_events(event_type, event_date DESC);
