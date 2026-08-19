-- Add runtime-owned tables deferred from the immutable domain baseline.
CREATE TABLE IF NOT EXISTS model_health_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  accuracy_30d    REAL,
  accuracy_90d    REAL,
  profit_factor   REAL,
  expectancy      REAL,
  lifecycle_status TEXT,
  lifecycle_weight REAL,
  ic_mean         REAL,
  drift_detected  INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(date, model_name)
);

CREATE TABLE IF NOT EXISTS model_lifecycle_state (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  state_json    TEXT NOT NULL,
  events_json   TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_lifecycle_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date    TEXT NOT NULL,
  model_name    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  accuracy_30d  REAL,
  detail        TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS persona_opinions (
  date                   TEXT NOT NULL,
  symbol                 TEXT NOT NULL,


  trust_signal           TEXT,
  trust_strength         REAL,
  trust_reason           TEXT,
  trust_is_window_dress  INTEGER DEFAULT 0,


  retail_signal          TEXT,
  retail_strength        REAL,
  retail_reason          TEXT,


  created_at             TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (date, symbol)
);

CREATE TABLE IF NOT EXISTS config_lifecycle_state (
  id                        INTEGER PRIMARY KEY DEFAULT 1,
  state_json                TEXT NOT NULL,
  last_eval_json            TEXT,
  updated_at                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_lifecycle_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date        TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  challenger_source TEXT,
  champion_hash     TEXT,
  challenger_hash   TEXT,
  sharpe_delta      REAL,
  win_rate_delta    REAL,
  max_dd_delta      REAL,
  detail            TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_threshold_calibration_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
  status TEXT NOT NULL CHECK(status IN ('success','partial','skipped','failed')),
  specs_seen INTEGER NOT NULL DEFAULT 0,
  artifacts_written INTEGER NOT NULL DEFAULT 0,
  guardrails_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_threshold_calibration_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  target_key TEXT NOT NULL DEFAULT 'featureRefs.weightedScore.min',
  status TEXT NOT NULL CHECK(status IN ('approved','rejected','frozen','rolled_back')),
  cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
  base_min REAL NOT NULL,
  previous_min REAL,
  calibrated_min REAL NOT NULL,
  delta REAL NOT NULL,
  validation_start TEXT NOT NULL,
  validation_end TEXT NOT NULL,
  guardrails_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  superseded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_health_date ON model_health_daily(date DESC);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_date ON model_lifecycle_events(event_date DESC);

CREATE INDEX IF NOT EXISTS idx_persona_opinions_date
  ON persona_opinions(date DESC);

CREATE INDEX IF NOT EXISTS idx_config_lifecycle_events_date ON config_lifecycle_events(event_date DESC);

CREATE INDEX IF NOT EXISTS idx_config_lifecycle_events_type ON config_lifecycle_events(event_type, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_threshold_artifacts_latest
  ON strategy_threshold_calibration_artifacts(strategy_id, strategy_version, target_key, status, approved_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_threshold_artifacts_run
  ON strategy_threshold_calibration_artifacts(run_id, status);
