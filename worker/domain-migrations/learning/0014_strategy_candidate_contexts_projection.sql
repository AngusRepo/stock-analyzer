-- Materialize the compact strategy context projection in the active Learning owner.
-- Historical payloads are copied from the frozen legacy source with exact row parity.
CREATE TABLE IF NOT EXISTS strategy_candidate_contexts (
  context_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  raw_signals_json TEXT NOT NULL DEFAULT '{}',
  current_price REAL,
  industry TEXT,
  artifact_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, context_hash)
);

CREATE INDEX IF NOT EXISTS idx_strategy_candidate_contexts_date_symbol
  ON strategy_candidate_contexts(date DESC, symbol);
