-- Add runtime-owned tables deferred from the immutable domain baseline.
CREATE TABLE IF NOT EXISTS decision_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  action          TEXT NOT NULL,

  chip_score      REAL,
  tech_score      REAL,
  ml_score        REAL,
  total_score     REAL,
  chip_pct        REAL,
  tech_pct        REAL,
  ml_pct          REAL,

  ml_signal       TEXT,
  ml_confidence   REAL,

  debate_verdict  TEXT,
  debate_summary  TEXT,

  model_breakdown TEXT,

  market_risk     TEXT,
  sector          TEXT,
  entry_price     REAL,
  created_at      TEXT DEFAULT (datetime('now')), score_components TEXT,
  UNIQUE(date, symbol, action)
);

CREATE TABLE IF NOT EXISTS debate_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  debate_date TEXT NOT NULL,
  thesis_summary TEXT NOT NULL,
  direction TEXT NOT NULL,
  key_factors TEXT,
  verdict TEXT,
  conviction_score INTEGER,
  llm_source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exit_shadow_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL,
  date                TEXT NOT NULL,
  caller              TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  regime              TEXT NOT NULL,
  actual_action       TEXT NOT NULL,
  actual_reason       TEXT,
  hypothetical_order  TEXT,
  hypothetical_mult   TEXT
);

CREATE TABLE IF NOT EXISTS pending_buy_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date        TEXT NOT NULL,
  source_reco_date  TEXT,
  status            TEXT NOT NULL DEFAULT 'ready',
  debate_status     TEXT NOT NULL DEFAULT 'pending',
  candidate_count   INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_buy_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES pending_buy_runs(id) ON DELETE CASCADE,
  symbol            TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  signal            TEXT NOT NULL DEFAULT 'BUY',
  confidence        REAL NOT NULL DEFAULT 0,
  ml_entry_price    REAL NOT NULL DEFAULT 0,
  ml_stop_loss      REAL,
  ml_target1        REAL,
  ml_target2        REAL,
  reason            TEXT,
  watch_points_json TEXT,
  debate_verdict    TEXT NOT NULL DEFAULT 'PENDING',
  debate_status     TEXT NOT NULL DEFAULT 'pending',
  execution_status  TEXT NOT NULL DEFAULT 'pending',
  risk_pct          REAL NOT NULL DEFAULT 0,
  kelly_pct         REAL,
  chip_score        REAL,
  tech_score        REAL,
  ml_score          REAL,
  score             REAL,
  source            TEXT,
  original_entry    REAL,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')), debate_turns_json TEXT,
  UNIQUE(run_id, symbol)
);

CREATE TABLE IF NOT EXISTS promotion_audit_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id         TEXT NOT NULL,
  from_state           TEXT,
  to_state             TEXT,
  decision             TEXT NOT NULL,
  failed_gates_json    TEXT,
  packet_json          TEXT NOT NULL,
  real_trading_effect  TEXT NOT NULL DEFAULT 'none',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_buy_filter_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES pending_buy_runs(id) ON DELETE CASCADE,
  trade_date        TEXT NOT NULL,
  source_reco_date  TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  name              TEXT,
  stage             TEXT NOT NULL,
  action            TEXT NOT NULL,
  reason_code       TEXT NOT NULL,
  theme             TEXT,
  classification    TEXT,
  quadrant          TEXT,
  rs_ratio          REAL,
  rs_momentum       REAL,
  risk_multiplier   REAL,
  details_json      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_date ON decision_logs(date DESC);

CREATE INDEX IF NOT EXISTS idx_debate_memory_sym_date ON debate_memory(symbol, debate_date DESC);

CREATE INDEX IF NOT EXISTS idx_debate_memory_date     ON debate_memory(debate_date);

CREATE INDEX IF NOT EXISTS idx_exit_shadow_date   ON exit_shadow_log(date DESC);

CREATE INDEX IF NOT EXISTS idx_exit_shadow_regime ON exit_shadow_log(regime, date DESC);

CREATE INDEX IF NOT EXISTS idx_exit_shadow_symbol ON exit_shadow_log(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_runs_trade_date
  ON pending_buy_runs(trade_date, id DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_runs_status
  ON pending_buy_runs(status, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_run
  ON pending_buy_items(run_id, score DESC, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_symbol
  ON pending_buy_items(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_execution
  ON pending_buy_items(execution_status, debate_status, symbol);

CREATE INDEX IF NOT EXISTS idx_promotion_audit_events_candidate
  ON promotion_audit_events(candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_debate_status_symbol
  ON pending_buy_items(debate_status, symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_filter_audit_run
  ON pending_buy_filter_audit(run_id, stage, action);

CREATE INDEX IF NOT EXISTS idx_pending_buy_filter_audit_trade_date
  ON pending_buy_filter_audit(trade_date DESC, source_reco_date, symbol);

CREATE INDEX IF NOT EXISTS idx_pending_buy_filter_audit_reason
  ON pending_buy_filter_audit(reason_code, trade_date DESC);
