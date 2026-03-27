-- Wave 3: 融資融券 + 集保餘額
-- 2026-03-25

-- 個股融資融券（每日更新）
CREATE TABLE IF NOT EXISTS margin_data (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id              INTEGER NOT NULL REFERENCES stocks(id),
  date                  TEXT NOT NULL,
  margin_buy            INTEGER,       -- 融資買入（張）
  margin_sell           INTEGER,       -- 融資賣出（張）
  margin_balance        INTEGER,       -- 融資餘額（張）
  short_buy             INTEGER,       -- 融券買入（張）
  short_sell            INTEGER,       -- 融券賣出（張）
  short_balance         INTEGER,       -- 融券餘額（張）
  margin_usage_pct      REAL,          -- 融資使用率 %（需外部計算或 FinMind 提供）
  short_ratio           REAL,          -- 券資比 = short_balance / margin_balance
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_margin_data_stock_date ON margin_data(stock_id, date);

-- 集保餘額（每週更新）
CREATE TABLE IF NOT EXISTS shareholding (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id              INTEGER NOT NULL REFERENCES stocks(id),
  date                  TEXT NOT NULL,
  total_shares          INTEGER,       -- 總股數
  holder_count          INTEGER,       -- 總股東人數
  retail_shares         INTEGER,       -- 散戶持股（<50張）
  retail_pct            REAL,          -- 散戶持股占比 %
  large_holder_shares   INTEGER,       -- 大戶持股（>=400張）
  large_holder_pct      REAL,          -- 大戶持股占比 %
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_shareholding_stock_date ON shareholding(stock_id, date);
