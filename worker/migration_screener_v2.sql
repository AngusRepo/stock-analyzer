-- migration_screener_v2.sql — Bottom-up Screener v2
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_screener_v2.sql

-- daily_recommendations 加官方產業別欄位
ALTER TABLE daily_recommendations ADD COLUMN industry TEXT;
