-- migration_screener.sql — Market Screener 系統所需的 schema 變更
-- 執行：wrangler d1 execute stockvision --file=./migration_screener.sql

-- stocks 表加 source 欄位（區分手動 vs 篩選器自動加入）
-- source = 'manual'    → 使用者手動 add（永久）
-- source = 'screener'  → 每日篩選器自動加入（每日更新）
ALTER TABLE stocks ADD COLUMN source TEXT DEFAULT 'manual';

-- 族群熱度歷史（用於追蹤族群輪動趨勢）
CREATE TABLE IF NOT EXISTS sector_heat (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL,
  sector            TEXT NOT NULL,
  score             REAL NOT NULL,
  chip_flow         REAL,
  relative_strength REAL,
  volume_expansion  REAL,
  momentum          REAL,
  top_stocks        TEXT,           -- JSON array of top symbols
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, sector)
);

CREATE INDEX IF NOT EXISTS idx_sector_heat_date ON sector_heat(date DESC, score DESC);
