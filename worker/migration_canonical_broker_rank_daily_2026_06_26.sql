-- Canonical broker-level daily top flow ranks.
-- Complements canonical_broker_flow_daily aggregate rows with card-ready
-- top buy/sell broker detail. Values are lots because FinLab broker
-- transaction feeds expose broker trading quantity in board lots.

CREATE TABLE IF NOT EXISTS canonical_broker_rank_daily (
  stock_id       TEXT NOT NULL,
  date           TEXT NOT NULL,
  market_segment TEXT NOT NULL DEFAULT 'LISTED_OTC',
  rank_side      TEXT NOT NULL CHECK(rank_side IN ('buy', 'sell')),
  rank_no        INTEGER NOT NULL CHECK(rank_no BETWEEN 1 AND 3),
  broker_code    TEXT,
  broker_name    TEXT,
  buy_lots       REAL,
  sell_lots      REAL,
  net_lots       REAL,
  source         TEXT NOT NULL DEFAULT 'finlab.broker_transactions',
  lineage_json   TEXT NOT NULL,
  as_of_date     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source, rank_side, rank_no)
);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_rank_date
  ON canonical_broker_rank_daily(date DESC, market_segment, rank_side);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_rank_symbol
  ON canonical_broker_rank_daily(stock_id, date DESC);
