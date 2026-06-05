CREATE TABLE IF NOT EXISTS state_space_shadow_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'modal_state_space_shadow',
  model_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  stock_id INTEGER,
  horizon INTEGER,
  forecast_pct REAL,
  up_prob REAL,
  confidence REAL,
  direction TEXT,
  model_version TEXT,
  n_used INTEGER,
  degraded INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  error TEXT,
  diagnostics_json TEXT,
  overlay_json TEXT NOT NULL,
  callback_json TEXT,
  function_call_id TEXT,
  elapsed_s REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_date, run_id, model_name, symbol)
);

CREATE INDEX IF NOT EXISTS idx_state_space_shadow_run
  ON state_space_shadow_results(run_date, run_id);

CREATE INDEX IF NOT EXISTS idx_state_space_shadow_model_symbol
  ON state_space_shadow_results(model_name, symbol, run_date);

CREATE INDEX IF NOT EXISTS idx_state_space_shadow_errors
  ON state_space_shadow_results(run_date, model_name, error, fallback_reason);
