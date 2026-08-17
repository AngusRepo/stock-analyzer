CREATE TABLE IF NOT EXISTS canonical_revenue_observations_v2 (
  stock_id TEXT NOT NULL,
  revenue_month TEXT NOT NULL,
  market_segment TEXT,
  revenue REAL,
  previous_month_revenue REAL,
  last_year_month_revenue REAL,
  mom REAL,
  yoy REAL,
  cumulative_revenue REAL,
  last_year_cumulative_revenue REAL,
  previous_comparison_pct REAL,
  source TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  source_as_of_date TEXT NOT NULL,
  knowledge_time TEXT NOT NULL,
  observation_run_id TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, revenue_month, source, payload_checksum),
  CHECK(length(payload_checksum) = 71)
);

CREATE INDEX IF NOT EXISTS idx_revenue_observations_v2_stock_knowledge
  ON canonical_revenue_observations_v2(stock_id, knowledge_time, revenue_month);

