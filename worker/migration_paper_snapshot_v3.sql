-- ─── Paper Trading Snapshot v3：新增 TWII 大盤指數欄位 ────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_paper_snapshot_v3.sql
--
-- 新增欄位：
--   twii_value — 加權指數當日收盤價（用於計算相對大盤績效）

ALTER TABLE paper_daily_snapshots ADD COLUMN twii_value REAL;
