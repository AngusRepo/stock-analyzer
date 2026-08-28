-- Generated from schema.sql plus production snapshot fallback; do not edit by hand.
CREATE TABLE IF NOT EXISTS paper_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL DEFAULT 'AI 模擬帳戶',
  cash          REAL NOT NULL DEFAULT 1000000.0,
  initial_cash  REAL NOT NULL DEFAULT 1000000.0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES paper_accounts(id),
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  side          TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  shares        INTEGER NOT NULL,
  price         REAL NOT NULL,
  commission    REAL NOT NULL DEFAULT 0,
  tax           REAL NOT NULL DEFAULT 0,
  total_cost    REAL NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  signal        TEXT,
  confidence    REAL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES paper_accounts(id),
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  shares        INTEGER NOT NULL,
  avg_cost      REAL NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')), entry_price REAL, entry_date TEXT, initial_stop REAL, trailing_stop REAL, highest_since_entry REAL, stop_multiplier REAL DEFAULT 2.0, tp1_price REAL, tp2_price REAL, tp1_hit INTEGER DEFAULT 0, original_shares INTEGER, trade_lifecycle_json TEXT,
  UNIQUE(account_id, symbol)
);

CREATE TABLE IF NOT EXISTS paper_daily_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES paper_accounts(id),
  date            TEXT NOT NULL,
  cash            REAL NOT NULL,
  positions_value REAL NOT NULL,
  total_value     REAL NOT NULL,
  pnl             REAL NOT NULL,
  pnl_pct         REAL NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')), benchmark_value     REAL, max_drawdown_to_date REAL, sharpe_30d          REAL, twii_value REAL, sortino_30d REAL, calmar       REAL, cagr         REAL,
  UNIQUE(account_id, date)
);

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

CREATE TABLE IF NOT EXISTS paper_settlements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL,
  order_id        INTEGER NOT NULL,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  amount          REAL NOT NULL,
  trade_date      TEXT NOT NULL,
  settlement_date TEXT NOT NULL,
  settled         INTEGER NOT NULL DEFAULT 0,
  settled_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS paper_kelly_calibration_runs_v1 (
  run_id TEXT PRIMARY KEY,
  artifact_version TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_maturity','rejected','approved','promoted')),
  confidence_semantic TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
  date_count INTEGER NOT NULL DEFAULT 0 CHECK(date_count >= 0),
  train_dates_json TEXT NOT NULL DEFAULT '[]',
  purge_dates_json TEXT NOT NULL DEFAULT '[]',
  oos_dates_json TEXT NOT NULL DEFAULT '[]',
  source_checksum TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  gates_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_kelly_calibration_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK(method='paper-kelly-pav-v1'),
  knowledge_cutoff_date TEXT NOT NULL,
  trained_through_date TEXT NOT NULL,
  confidence_semantic TEXT NOT NULL,
  bins_json TEXT NOT NULL,
  average_win_return REAL NOT NULL CHECK(average_win_return > 0),
  average_loss_return REAL NOT NULL CHECK(average_loss_return > 0),
  fractional_kelly REAL NOT NULL CHECK(fractional_kelly > 0 AND fractional_kelly <= 1),
  max_kelly_pct REAL NOT NULL CHECK(max_kelly_pct > 0 AND max_kelly_pct <= 0.15),
  source_checksum TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES paper_kelly_calibration_runs_v1(run_id)
);

CREATE TABLE IF NOT EXISTS paper_kelly_calibration_head_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES paper_kelly_calibration_runs_v1(run_id),
  FOREIGN KEY(artifact_id) REFERENCES paper_kelly_calibration_artifacts_v1(artifact_id)
);

CREATE TABLE IF NOT EXISTS paper_order_intents (
  intent_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  order_id INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_execution_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL DEFAULT 1,
  trade_date      TEXT NOT NULL,
  symbol          TEXT,
  side            TEXT,
  event_type      TEXT NOT NULL,
  status          TEXT NOT NULL,
  reason          TEXT,
  detail_json     TEXT,
  order_id        INTEGER,
  pending_run_id  INTEGER,
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_challenger_candidates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id           TEXT NOT NULL UNIQUE,
  candidate_type         TEXT NOT NULL,
  current_state          TEXT NOT NULL,
  source                 TEXT NOT NULL,
  feature_set_version    TEXT,
  first_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  promotion_packet_json  TEXT,
  notes                  TEXT
);

CREATE TABLE IF NOT EXISTS paper_decision_attribution (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date            TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  decision              TEXT NOT NULL,
  paper_lane            TEXT NOT NULL,
  candidate_source      TEXT NOT NULL,
  baseline_score        REAL,
  challenger_score      REAL,
  decision_delta        REAL,
  feature_set_version   TEXT,
  regime_version        TEXT,
  evidence_sources_json TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_challenger_daily_metrics (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date           TEXT NOT NULL,
  candidate_id         TEXT NOT NULL,
  paper_decision_count INTEGER NOT NULL DEFAULT 0,
  precision_at_k       REAL,
  hit_rate             REAL,
  avg_return_pct       REAL,
  max_drawdown_pct     REAL,
  turnover_ratio       REAL,
  topk_overlap         REAL,
  regime_split_passed  INTEGER NOT NULL DEFAULT 0,
  runtime_speedup_pct  REAL,
  metrics_json         TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trade_date, candidate_id)
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

CREATE TABLE IF NOT EXISTS paper_exit_intents (
  intent_key TEXT NOT NULL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_date TEXT,
  requested_shares INTEGER NOT NULL,
  remaining_shares INTEGER NOT NULL,
  stop_price REAL NOT NULL,
  stop_version TEXT NOT NULL,
  trigger_price REAL NOT NULL,
  trigger_time TEXT,
  received_at TEXT NOT NULL,
  session_epoch INTEGER,
  trigger_source TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'EXIT_TRIGGERED_WAITING_BOOK'
    CHECK (state IN (
      'EXIT_TRIGGERED_WAITING_BOOK',
      'SUBMITTING',
      'PARTIAL',
      'FILLED',
      'CANCELLED',
      'SUPERSEDED'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  resolution_order_id INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_account ON paper_orders(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol  ON paper_orders(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_snapshots ON paper_daily_snapshots(account_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_decision_logs_date ON decision_logs(date DESC);

CREATE INDEX IF NOT EXISTS idx_settlements_pending ON paper_settlements(settled, settlement_date);

CREATE INDEX IF NOT EXISTS idx_settlements_account ON paper_settlements(account_id, settled);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_order_intents_unique
  ON paper_order_intents(account_id, trade_date, symbol, side, source);

CREATE INDEX IF NOT EXISTS idx_paper_order_intents_date
  ON paper_order_intents(trade_date, status);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_date
  ON paper_execution_events(trade_date DESC, event_type, status);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_symbol
  ON paper_execution_events(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_order
  ON paper_execution_events(order_id);

CREATE INDEX IF NOT EXISTS idx_paper_orders_account_side_created
  ON paper_orders(account_id, side, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_positions_account_symbol_shares
  ON paper_positions(account_id, symbol, shares);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_account_created
  ON paper_execution_events(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_challenger_candidates_state
  ON paper_challenger_candidates(current_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_decision_attribution_symbol_date
  ON paper_decision_attribution(symbol, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_paper_decision_attribution_candidate
  ON paper_decision_attribution(candidate_source, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_paper_challenger_daily_metrics_candidate
  ON paper_challenger_daily_metrics(candidate_id, trade_date DESC);

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

CREATE INDEX IF NOT EXISTS idx_paper_exit_intents_active_symbol
  ON paper_exit_intents(account_id, symbol, entry_date, state, created_at);

CREATE INDEX IF NOT EXISTS idx_paper_exit_intents_retry
  ON paper_exit_intents(state, next_attempt_at, updated_at);
