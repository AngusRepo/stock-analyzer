-- migration_momentum_zone.sql — Momentum Crash Zone Detection (2026-04-15)
--
-- Purpose: Track the screener candidate pool's momentum-concentration state
-- and compare against a rolling 36-month distribution. When current state is
-- in the historical left tail (< P10), the market is flagged as a
-- "momentum crash" regime (Daniel & Moskowitz 2016 JFE 122(2)), so
-- morning-setup will size down new positions.
--
-- Execute: wrangler d1 execute stockvision-db --remote --file=./worker/migration_momentum_zone.sql

CREATE TABLE IF NOT EXISTS screener_momentum_snapshots (
  date                  TEXT PRIMARY KEY,         -- trading day (TW timezone YYYY-MM-DD)
  candidate_count       INTEGER NOT NULL,         -- size of screener candidate pool
  avg_5d_return         REAL,                     -- mean 5-day return of candidates
  pct_oversold          REAL,                     -- % of candidates with RSI < 30 OR close < MA20
  pct_overbought        REAL,                     -- % of candidates with RSI > 70
  avg_dist_from_high    REAL,                     -- mean distance below 52-week high (fraction, e.g. 0.12 = 12% below)
  breadth_score         REAL,                     -- advance/decline-weighted score, [-1, 1]
  -- Zone fields (computed at write time against prior 36 months)
  percentile_rank       REAL,                     -- rank of today's pct_oversold in [0, 1]; lower = more crowded/risky
  zone                  TEXT NOT NULL DEFAULT 'GREEN', -- 'RED' | 'YELLOW' | 'GREEN'
  created_at            TEXT DEFAULT (datetime('now'))
);

-- Index for rolling-window percentile queries
CREATE INDEX IF NOT EXISTS idx_momentum_snapshots_date
  ON screener_momentum_snapshots(date DESC);
