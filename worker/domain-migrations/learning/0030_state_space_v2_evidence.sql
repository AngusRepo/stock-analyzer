CREATE TABLE IF NOT EXISTS state_space_v2_runs (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version = 'state-space-observation-v2'),
  contract_version TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  horizon_sessions INTEGER NOT NULL CHECK(horizon_sessions > 0),
  observation_count INTEGER NOT NULL CHECK(observation_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  input_evidence_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect = 0),
  status TEXT NOT NULL DEFAULT 'complete' CHECK(status IN ('complete','blocked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_state_space_v2_runs_date
  ON state_space_v2_runs(as_of_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS state_space_v2_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES state_space_v2_runs(run_id),
  as_of_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  stock_id INTEGER,
  horizon_sessions INTEGER NOT NULL CHECK(horizon_sessions > 0),
  n_used INTEGER NOT NULL CHECK(n_used >= 60),
  observed_price REAL NOT NULL CHECK(observed_price > 0),
  latent_level REAL NOT NULL,
  latent_slope_1d REAL NOT NULL,
  forecast_return REAL NOT NULL,
  forecast_variance REAL NOT NULL CHECK(forecast_variance > 0),
  up_probability REAL NOT NULL CHECK(up_probability >= 0 AND up_probability <= 1),
  innovation_z REAL NOT NULL,
  level_uncertainty REAL NOT NULL CHECK(level_uncertainty >= 0),
  slope_uncertainty REAL NOT NULL CHECK(slope_uncertainty >= 0),
  input_checksum TEXT NOT NULL CHECK(length(input_checksum) = 64),
  observation_checksum TEXT NOT NULL CHECK(length(observation_checksum) = 64),
  sequence_source TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect = 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_state_space_v2_observations_maturity
  ON state_space_v2_observations(as_of_date, horizon_sessions, symbol);

CREATE TABLE IF NOT EXISTS state_space_v2_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES state_space_v2_observations(observation_id),
  outcome_date TEXT NOT NULL,
  outcome_price REAL NOT NULL CHECK(outcome_price > 0),
  realized_return REAL NOT NULL,
  direction_correct INTEGER NOT NULL CHECK(direction_correct IN (0,1)),
  squared_error REAL NOT NULL CHECK(squared_error >= 0),
  absolute_error REAL NOT NULL CHECK(absolute_error >= 0),
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect = 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_state_space_v2_evaluations_date
  ON state_space_v2_evaluations(outcome_date DESC, created_at DESC);
