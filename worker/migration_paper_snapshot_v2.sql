-- ─── Paper Trading Snapshot v2：新增風險指標欄位 ─────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_paper_snapshot_v2.sql
--
-- 新增欄位（均 nullable，確保 migration 冪等且不破壞現有資料）：
--   benchmark_value     — 0050 當日收盤價（用於計算相對大盤績效）
--   max_drawdown_to_date — 自帳戶開立以來的最大回落（正值，如 0.12 = 12%）
--   sharpe_30d          — 近 30 日年化 Sharpe Ratio（需 30 筆以上資料才有意義）

ALTER TABLE paper_daily_snapshots ADD COLUMN benchmark_value     REAL;
ALTER TABLE paper_daily_snapshots ADD COLUMN max_drawdown_to_date REAL;
ALTER TABLE paper_daily_snapshots ADD COLUMN sharpe_30d          REAL;
