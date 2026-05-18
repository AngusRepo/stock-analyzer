-- V4.1 paper-active challenger attribution and promotion evidence.
-- Run only after Wei approval:
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_paper_active_challenger.sql

CREATE TABLE IF NOT EXISTS paper_challenger_candidates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id           TEXT NOT NULL UNIQUE,
  candidate_type         TEXT NOT NULL,
  current_state          TEXT NOT NULL, -- candidate | clean_asset | paper_active_challenger | paper_primary | real_review_ready
  source                 TEXT NOT NULL,
  feature_set_version    TEXT,
  first_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  promotion_packet_json  TEXT,
  notes                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_challenger_candidates_state
  ON paper_challenger_candidates(current_state, updated_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_paper_decision_attribution_symbol_date
  ON paper_decision_attribution(symbol, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_paper_decision_attribution_candidate
  ON paper_decision_attribution(candidate_source, trade_date DESC);

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

CREATE INDEX IF NOT EXISTS idx_paper_challenger_daily_metrics_candidate
  ON paper_challenger_daily_metrics(candidate_id, trade_date DESC);

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

CREATE INDEX IF NOT EXISTS idx_promotion_audit_events_candidate
  ON promotion_audit_events(candidate_id, created_at DESC);
