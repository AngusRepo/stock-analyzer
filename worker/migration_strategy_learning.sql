CREATE TABLE IF NOT EXISTS strategy_spec_registry (
  strategy_id              TEXT NOT NULL,
  version                  TEXT NOT NULL,
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('research','shadow','candidate','active','retired')),
  owner                    TEXT NOT NULL DEFAULT 'strategy',
  alpha_bucket             TEXT NOT NULL,
  supported_regimes_json   TEXT NOT NULL DEFAULT '[]',
  thesis                   TEXT NOT NULL,
  thresholds_json          TEXT NOT NULL DEFAULT '{}',
  risk_notes_json          TEXT NOT NULL DEFAULT '[]',
  source_refs_json         TEXT NOT NULL DEFAULT '[]',
  created_by               TEXT NOT NULL DEFAULT 'p5_strategy_governance',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_id, version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_status
  ON strategy_spec_registry(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_bucket
  ON strategy_spec_registry(alpha_bucket, status);

CREATE TABLE IF NOT EXISTS strategy_decision_log (
  decision_id              TEXT PRIMARY KEY,
  date                     TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  name                     TEXT,
  strategy_id              TEXT NOT NULL,
  strategy_version         TEXT NOT NULL,
  strategy_status          TEXT NOT NULL,
  alpha_bucket             TEXT NOT NULL,
  matched                  INTEGER NOT NULL DEFAULT 0,
  match_score              REAL,
  reason_code              TEXT NOT NULL,
  context_json             TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, strategy_id, strategy_version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_date
  ON strategy_decision_log(date DESC, strategy_id, matched);
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_symbol
  ON strategy_decision_log(symbol, date DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_status
  ON strategy_decision_log(strategy_status, matched, date DESC);

CREATE TABLE IF NOT EXISTS strategy_reward_ledger (
  reward_id                TEXT PRIMARY KEY,
  strategy_id              TEXT NOT NULL,
  strategy_version         TEXT NOT NULL,
  strategy_status          TEXT NOT NULL,
  alpha_bucket             TEXT NOT NULL,
  date_start               TEXT,
  date_end                 TEXT,
  horizon_days             INTEGER NOT NULL DEFAULT 5,
  samples                  INTEGER NOT NULL DEFAULT 0,
  hit_rate                 REAL,
  avg_return_pct           REAL,
  reward_sum               REAL,
  max_drawdown_pct         REAL,
  coverage                 REAL,
  market_segment           TEXT DEFAULT 'all',
  regime                   TEXT DEFAULT 'all',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(strategy_id, strategy_version, horizon_days, market_segment, regime)
);
CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_strategy
  ON strategy_reward_ledger(strategy_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_status
  ON strategy_reward_ledger(strategy_status, samples DESC);

CREATE TABLE IF NOT EXISTS strategy_policy_state (
  policy_id                TEXT PRIMARY KEY,
  version                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
  strategy_weights_json    TEXT NOT NULL DEFAULT '{}',
  threshold_deltas_json    TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
