-- ─── Monte Carlo MDD Results: P0#5 ──────────────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_monte_carlo.sql

CREATE TABLE IF NOT EXISTS monte_carlo_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date          TEXT NOT NULL,                    -- 執行日期
  source            TEXT NOT NULL DEFAULT 'paper',    -- 'paper' | 'backtest'
  n_simulations     INTEGER NOT NULL DEFAULT 1000,
  n_trades          INTEGER NOT NULL,                 -- 輸入交易筆數
  historical_mdd    REAL,                             -- 實際歷史 MDD (0~1)
  mdd_median        REAL,                             -- 模擬中位數
  mdd_mean          REAL,                             -- 模擬平均
  mdd_std           REAL,                             -- MDD 標準差
  mdd_95th          REAL,                             -- 95% 信賴區間上限 ← 主指標
  mdd_99th          REAL,                             -- 99% 信賴區間上限
  mdd_worst         REAL,                             -- 最差情境
  mdd_best          REAL,                             -- 最佳情境
  go_live_verdict   TEXT,                             -- 'PASS' | 'CAUTION' | 'FAIL'
  verdict_reason    TEXT,                             -- 判決說明
  raw_distribution  TEXT,                             -- Full JSON (distribution + histogram)
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, source)
);
