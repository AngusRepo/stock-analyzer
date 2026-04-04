-- ─── P1#15: Three-layer Observability ────────────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_observability.sql

-- L2: Per-trade decision attribution (WHY was this trade made?)
CREATE TABLE IF NOT EXISTS decision_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  action          TEXT NOT NULL,              -- 'BUY' | 'SELL' | 'SWAP_OUT' | 'SKIP'
  -- Factor contributions (from scorer)
  chip_score      REAL,                       -- 0-40
  tech_score      REAL,                       -- 0-30
  ml_score        REAL,                       -- 0-30
  total_score     REAL,                       -- chip + tech + ml
  chip_pct        REAL,                       -- chip_score / total_score (contribution %)
  tech_pct        REAL,
  ml_pct          REAL,
  -- ML detail
  ml_signal       TEXT,                       -- BUY / STRONG_BUY / HOLD / SELL
  ml_confidence   REAL,
  -- Debate verdict
  debate_verdict  TEXT,                       -- APPROVE / DOWNGRADE / REJECT / null
  debate_summary  TEXT,
  -- Model breakdown (JSON: per-model weight + direction)
  model_breakdown TEXT,                       -- JSON [{name, weight, direction, accuracy}, ...]
  -- Context
  market_risk     TEXT,                       -- green/yellow/orange/red/black
  sector          TEXT,
  entry_price     REAL,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(date, symbol, action)
);
CREATE INDEX IF NOT EXISTS idx_decision_logs_date ON decision_logs(date DESC);

-- L3: Daily model health snapshot (per-model accuracy + drift + IC)
CREATE TABLE IF NOT EXISTS model_health_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  accuracy_30d    REAL,
  accuracy_90d    REAL,
  profit_factor   REAL,
  expectancy      REAL,
  lifecycle_status TEXT,                      -- 'active' | 'degraded' | 'shadow'
  lifecycle_weight REAL,                      -- current weight multiplier
  ic_mean         REAL,                       -- latest feature IC (if available)
  drift_detected  INTEGER DEFAULT 0,          -- 1 if drift detected
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(date, model_name)
);
CREATE INDEX IF NOT EXISTS idx_model_health_date ON model_health_daily(date DESC);
