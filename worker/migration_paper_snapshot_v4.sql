-- ─── P0#7: 新增 Sortino / Calmar / CAGR 到 daily snapshot ──────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_paper_snapshot_v4.sql
-- 已有欄位：sharpe_30d, benchmark_value, twii_value, max_drawdown_to_date

ALTER TABLE paper_daily_snapshots ADD COLUMN sortino_30d REAL;   -- 近 30 日年化 Sortino
ALTER TABLE paper_daily_snapshots ADD COLUMN calmar       REAL;   -- CAGR / MDD
ALTER TABLE paper_daily_snapshots ADD COLUMN cagr         REAL;   -- 年化複合報酬率
