-- Append-only HMM publication revisions. Original first-observation history is preserved.
CREATE TABLE IF NOT EXISTS market_regime_state_revisions_v1 (
 run_date TEXT NOT NULL, state_checksum TEXT NOT NULL CHECK(length(state_checksum)=64),
 state_json TEXT NOT NULL, computed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(run_date,state_checksum)
);
CREATE INDEX IF NOT EXISTS idx_market_regime_state_revisions_v1_asof
 ON market_regime_state_revisions_v1(run_date,computed_at DESC,recorded_at DESC);
