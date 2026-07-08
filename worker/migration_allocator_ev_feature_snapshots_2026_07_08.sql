CREATE TABLE IF NOT EXISTS allocator_ev_feature_snapshots (
  snapshot_date               TEXT NOT NULL,
  stock_id                    INTEGER NOT NULL,
  symbol                      TEXT NOT NULL,
  forecast_data               TEXT,
  score                       REAL,
  score_components            TEXT,
  alpha_context               TEXT,
  alpha_allocation            TEXT NOT NULL,
  market_heat_expected_return REAL,
  market_segment              TEXT,
  recommendation_lane         TEXT,
  snapshot_source             TEXT NOT NULL DEFAULT 'allocator_ev_asof_backfill_v1',
  l4_model_version            TEXT,
  s12_source                  TEXT,
  as_of_guard                 TEXT NOT NULL,
  source_recommendation_date  TEXT,
  generated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, stock_id, snapshot_source)
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshots_date
  ON allocator_ev_feature_snapshots(snapshot_date, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshots_symbol
  ON allocator_ev_feature_snapshots(symbol, snapshot_date DESC);
