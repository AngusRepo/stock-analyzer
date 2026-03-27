-- ─── Backtest Results: Freqtrade 回測結果儲存 ──────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_backtest_results.sql

CREATE TABLE IF NOT EXISTS backtest_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date        TEXT NOT NULL,                    -- 執行日期
  strategy        TEXT NOT NULL,                    -- 策略名稱
  timerange       TEXT,                             -- 回測區間 (e.g. '20240101-20260326')
  total_trades    INTEGER,
  win_rate        REAL,                             -- 0~1
  sharpe          REAL,
  sortino         REAL,
  calmar          REAL,
  max_drawdown    REAL,                             -- 正值 (e.g. 0.12 = 12%)
  cagr            REAL,
  profit_factor   REAL,
  expectancy      REAL,
  raw_results     TEXT,                             -- Full JSON (truncated 50KB)
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, strategy, timerange)
);
