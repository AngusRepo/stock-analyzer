-- migration_sector_flow_unique.sql
-- 修正 sector_flow UNIQUE 約束：(date, sector) → (date, sector, classification)
-- D1 SQLite 不支援 ALTER TABLE DROP CONSTRAINT，需重建 table
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_sector_flow_unique.sql

-- 1. 建立新 table（含正確的 UNIQUE 約束）
CREATE TABLE IF NOT EXISTS sector_flow_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  sector          TEXT NOT NULL,
  foreign_net     REAL,
  trust_net       REAL,
  total_net       REAL,
  avg_rsi         REAL,
  avg_momentum_5d REAL,
  stock_count     INTEGER,
  up_count        INTEGER,
  llm_summary     TEXT,
  classification  TEXT DEFAULT 'industry',
  rs_ratio        REAL,
  rs_momentum     REAL,
  quadrant        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, sector, classification)
);

-- 2. 搬移資料
INSERT OR IGNORE INTO sector_flow_new
  (date, sector, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d,
   stock_count, up_count, llm_summary, classification, rs_ratio, rs_momentum,
   quadrant, created_at)
SELECT date, sector, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d,
       stock_count, up_count, llm_summary,
       COALESCE(classification, 'industry'),
       rs_ratio, rs_momentum, quadrant, created_at
FROM sector_flow;

-- 3. 換 table
DROP TABLE sector_flow;
ALTER TABLE sector_flow_new RENAME TO sector_flow;

-- 4. 重建 index
CREATE INDEX IF NOT EXISTS idx_sector_flow_date ON sector_flow(date DESC, total_net DESC);
