-- migration_trade_signal_expand.sql
-- 擴展 trade_signal 允許 ensemble 原始 signal 值
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_trade_signal_expand.sql

-- D1 SQLite 不支援 ALTER COLUMN，但 CHECK 約束在 INSERT 時才驗證
-- 直接建新 column 替代（舊 column 保留向下相容）
ALTER TABLE predictions ADD COLUMN signal_raw TEXT;
