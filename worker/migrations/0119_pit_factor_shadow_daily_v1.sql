-- Prospective PIT residual-momentum challenger replacing the retired sector-rotation shadow.
-- This table has no production scoring, candidate-set, debate, sizing, or order authority.
CREATE TABLE IF NOT EXISTS pit_factor_shadow_daily_v1 (
  signal_date              TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  industry                 TEXT NOT NULL,
  taxonomy_snapshot_date   TEXT NOT NULL,
  taxonomy_checksum        TEXT NOT NULL,
  residual_momentum_rank   REAL NOT NULL CHECK(residual_momentum_rank BETWEEN 0 AND 1),
  breadth_rank             REAL CHECK(breadth_rank IS NULL OR breadth_rank BETWEEN 0 AND 1),
  flow_diffusion_rank      REAL CHECK(flow_diffusion_rank IS NULL OR flow_diffusion_rank BETWEEN 0 AND 1),
  research_base_score      REAL NOT NULL,
  research_shadow_score    REAL NOT NULL,
  residual_weight          REAL NOT NULL DEFAULT 0.10 CHECK(residual_weight = 0.10),
  primary_horizon_sessions INTEGER NOT NULL DEFAULT 10 CHECK(primary_horizon_sessions = 10),
  decision_effect          TEXT NOT NULL DEFAULT 'none' CHECK(decision_effect = 'none'),
  factor_contract_version  TEXT NOT NULL,
  diagnostics_json         TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_pit_factor_shadow_daily_v1_score
  ON pit_factor_shadow_daily_v1(signal_date DESC, research_shadow_score DESC);

CREATE INDEX IF NOT EXISTS idx_pit_factor_shadow_daily_v1_industry
  ON pit_factor_shadow_daily_v1(signal_date DESC, industry, residual_momentum_rank DESC);
