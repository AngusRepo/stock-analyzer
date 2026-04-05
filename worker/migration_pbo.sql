-- ─── PBO Results: P0#6 Probability of Backtest Overfitting ──────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_pbo.sql

CREATE TABLE IF NOT EXISTS pbo_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date          TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'backtest',  -- 'backtest' | 'paper'
  n_partitions      INTEGER NOT NULL DEFAULT 10,
  n_combinations    INTEGER NOT NULL,                  -- C(S, S/2) 總組合數
  n_trades          INTEGER NOT NULL,
  pbo               REAL NOT NULL,                     -- 0~1, 核心指標
  n_oos_negative    INTEGER NOT NULL,                  -- OOS 賠錢的組合數
  oos_mean_return   REAL,                              -- OOS 平均報酬
  is_mean_return    REAL,                              -- IS 平均報酬
  degradation       REAL,                              -- IS - OOS (過擬合差距)
  go_live_verdict   TEXT,                              -- 'PASS' | 'FAIL'
  verdict_reason    TEXT,
  raw_details       TEXT,                              -- Full JSON
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, source)
);
