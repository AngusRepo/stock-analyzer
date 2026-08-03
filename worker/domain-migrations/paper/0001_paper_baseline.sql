-- Immutable baseline for the paper D1 binding.
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

CREATE INDEX IF NOT EXISTS idx_settlements_pending ON paper_settlements(settled, settlement_date);

CREATE INDEX IF NOT EXISTS idx_settlements_account ON paper_settlements(account_id, settled);

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

CREATE INDEX IF NOT EXISTS idx_paper_exit_intents_active_symbol
  ON paper_exit_intents(account_id, symbol, entry_date, state, created_at);

CREATE INDEX IF NOT EXISTS idx_paper_exit_intents_retry
  ON paper_exit_intents(state, next_attempt_at, updated_at);
