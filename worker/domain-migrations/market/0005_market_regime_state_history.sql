-- Persist immutable daily HMM/effective regime state in Market D1.
-- KV remains only the current-state cache and a temporary compatibility mirror.

CREATE TABLE IF NOT EXISTS market_regime_state_history_v1 (
  run_date TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version='market-regime-state-v1'),
  effective_label TEXT NOT NULL CHECK(effective_label IN ('bull_market','bear_market','volatile','sideways')),
  raw_label TEXT NOT NULL CHECK(raw_label IN ('bull_market','bear_market','volatile','sideways')),
  family TEXT NOT NULL CHECK(family IN ('bull','bear','volatile','sideways')),
  source TEXT NOT NULL,
  hmm_state INTEGER NOT NULL,
  regime_index INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_checksum TEXT NOT NULL CHECK(length(state_checksum)=64),
  computed_at TEXT NOT NULL,
  persisted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_regime_state_history_v1_computed
  ON market_regime_state_history_v1(computed_at DESC, run_date DESC);
