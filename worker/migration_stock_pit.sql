-- ─── C1: Point-in-Time Stock Universe (存活偏差修正) ─────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_stock_pit.sql
-- 用途：回測時使用 point-in-time 股票宇宙，包含已下市股票

-- 新增上市/下市日期欄位
ALTER TABLE stocks ADD COLUMN listed_date TEXT;        -- 上市日 YYYY-MM-DD
ALTER TABLE stocks ADD COLUMN delisted_date TEXT;      -- 下市日（NULL = 仍在交易）
ALTER TABLE stocks ADD COLUMN delist_reason TEXT;      -- 'bankruptcy' | 'merger' | 'violation' | 'voluntary' | NULL

-- 回填現有股票：假設都是目前上市中
-- 實際 listed_date 需要從 TWSE/FinMind 回補
UPDATE stocks SET listed_date = '2020-01-01' WHERE listed_date IS NULL;
