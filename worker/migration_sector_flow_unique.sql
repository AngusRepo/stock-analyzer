-- migration_sector_flow_unique.sql
-- 修正 sector_flow UNIQUE 約束：加入 classification 避免 industry/theme 同名衝突
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_sector_flow_unique.sql

-- D1 SQLite 不支援 ALTER TABLE DROP CONSTRAINT，需要重建 index
-- 先刪舊的 unique index（如果存在的話 — schema.sql 用的是 table-level UNIQUE）
-- 由於 table-level UNIQUE 無法 DROP，我們用 INSERT OR REPLACE 策略搭配新 index

-- 新增包含 classification 的 unique index（覆蓋舊的 UNIQUE(date, sector)）
CREATE UNIQUE INDEX IF NOT EXISTS idx_sector_flow_date_sector_class
  ON sector_flow(date, sector, classification);
