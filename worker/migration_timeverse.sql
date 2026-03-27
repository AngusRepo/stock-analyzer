-- Timeverse 台股研究資料庫同步表
-- 2026-03-25

CREATE TABLE IF NOT EXISTS stock_profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL UNIQUE,
  name              TEXT,
  sector            TEXT,
  business_desc     TEXT,        -- 業務簡介（max 500 char）
  supply_chain      TEXT,        -- JSON: {upstream: [], midstream: [], downstream: []}
  key_customers     TEXT,        -- JSON array
  key_suppliers     TEXT,        -- JSON array
  financials_summary TEXT,       -- JSON: {annual: [...], quarterly: [...]}
  wikilinks         TEXT,        -- JSON array of [[linked]] entities
  updated_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_profiles_symbol ON stock_profiles(symbol);
