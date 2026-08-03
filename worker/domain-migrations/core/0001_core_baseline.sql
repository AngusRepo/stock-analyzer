-- Immutable baseline for the core D1 binding.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id   TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  avatar      TEXT,
  role        TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),

  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('approved','pending','rejected')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_login  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

CREATE TABLE IF NOT EXISTS stocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  market     TEXT NOT NULL DEFAULT 'TWSE' CHECK(market IN ('TWSE','OTC','US')),
  sector     TEXT,
  in_current_watchlist  INTEGER NOT NULL DEFAULT 1,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stocks_symbol ON stocks(symbol);

CREATE TABLE IF NOT EXISTS watchlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  cost_price  REAL,
  shares      REAL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, stock_id)
);

CREATE INDEX IF NOT EXISTS idx_wl_user_stock ON watchlist(user_id, stock_id);

CREATE TABLE IF NOT EXISTS risk_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  period             TEXT NOT NULL DEFAULT '1y',
  sharpe_ratio       REAL, sortino_ratio REAL,
  beta               REAL, max_drawdown REAL,
  var95              REAL, cvar95 REAL,
  annual_return      REAL, annual_volatility REAL,
  calculated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, period)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id         INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  rule_type        TEXT NOT NULL,
  threshold        REAL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  last_triggered   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON alert_rules(user_id);

CREATE INDEX IF NOT EXISTS idx_alerts_active ON alert_rules(is_active);

CREATE TABLE IF NOT EXISTS market_risk (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL UNIQUE,

  vix             REAL,
  vix_level       TEXT,

  twii_close      REAL,
  twii_vol20      REAL,
  twii_ma20       REAL,
  twii_bias       REAL,

  foreign_consecutive_sell INTEGER,
  foreign_net_5d  REAL,
  margin_ratio    REAL,

  limit_down_count INTEGER,
  limit_down_pct   REAL,

  risk_score      INTEGER,
  risk_level      TEXT,
  risk_summary    TEXT,
  calculated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_market_risk_date ON market_risk(date);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  stock_id    INTEGER REFERENCES stocks(id) ON DELETE CASCADE,
  title       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions ON chat_sessions(user_id, stock_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS alert_notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id     INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  stock_symbol TEXT NOT NULL,
  stock_name   TEXT,
  rule_type    TEXT NOT NULL,
  threshold    REAL,
  triggered_price REAL,
  is_read      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_user_read ON alert_notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS daily_recommendations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  stock_id     INTEGER REFERENCES stocks(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  name         TEXT NOT NULL,
  sector       TEXT,
  rank         INTEGER NOT NULL,
  score        REAL NOT NULL,
  signal       TEXT,
  confidence   REAL,

  reason       TEXT NOT NULL,
  watch_points TEXT,
  has_buy_signal INTEGER DEFAULT 0,

  current_price REAL,
  foreign_net_5d REAL,
  trust_net_5d   REAL,
  rsi14         REAL,
  macd_hist     REAL,
  sector_rank   TEXT,
  chip_score    REAL DEFAULT 0,
  tech_score    REAL DEFAULT 0,
  momentum_score REAL DEFAULT 0,
  ml_score      REAL DEFAULT 0,
  market_segment TEXT,
  recommendation_lane TEXT DEFAULT 'tradable',
  eligible_for_ml INTEGER DEFAULT 1,
  eligible_for_pending_buy INTEGER DEFAULT 1,
  alpha_context TEXT,
  alpha_allocation TEXT,
  ml_vote_summary TEXT,
  score_components TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, stock_id)
);

CREATE INDEX IF NOT EXISTS idx_rec_date ON daily_recommendations(date DESC);

CREATE INDEX IF NOT EXISTS idx_rec_date_rank_score
  ON daily_recommendations(date, rank, score DESC);

CREATE INDEX IF NOT EXISTS idx_rec_date_signal_score
  ON daily_recommendations(date, has_buy_signal, score DESC);

CREATE INDEX IF NOT EXISTS idx_rec_symbol_date
  ON daily_recommendations(symbol, date DESC);
