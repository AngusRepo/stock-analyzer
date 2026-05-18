-- V4.1 FinLab production materialization support.
-- This migration keeps TWSE/TPEX as audit/fallback while giving FinLab
-- canonical row-level data its own lineage surfaces.

CREATE TABLE IF NOT EXISTS canonical_broker_flow_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT NOT NULL DEFAULT 'EMERGING',
  buy_shares             REAL,
  sell_shares            REAL,
  net_shares             REAL,
  dominant_net_shares    REAL,
  gross_imbalance_shares REAL,
  estimated_amount       REAL,
  broker_count           INTEGER,
  concentration          REAL,
  source                 TEXT NOT NULL DEFAULT 'finlab.rotc_broker_transactions',
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source)
);
CREATE INDEX IF NOT EXISTS idx_canonical_broker_flow_date
  ON canonical_broker_flow_daily(date DESC, market_segment);
CREATE INDEX IF NOT EXISTS idx_canonical_broker_flow_symbol
  ON canonical_broker_flow_daily(stock_id, date DESC);

CREATE TABLE IF NOT EXISTS finlab_taxonomy_tags (
  symbol                 TEXT NOT NULL,
  tag                    TEXT NOT NULL,
  tag_type               TEXT NOT NULL,
  source                 TEXT NOT NULL,
  weight                 REAL NOT NULL DEFAULT 1,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, tag, tag_type, source)
);
CREATE INDEX IF NOT EXISTS idx_finlab_taxonomy_tags_symbol
  ON finlab_taxonomy_tags(symbol, tag_type);
CREATE INDEX IF NOT EXISTS idx_finlab_taxonomy_tags_tag
  ON finlab_taxonomy_tags(tag, tag_type);

CREATE TABLE IF NOT EXISTS finlab_materialization_manifest (
  run_id                 TEXT PRIMARY KEY,
  generated_at           TEXT NOT NULL,
  source_run_id          TEXT,
  artifact_root          TEXT NOT NULL,
  row_counts_json        TEXT NOT NULL,
  freshness_json         TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ready',
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
