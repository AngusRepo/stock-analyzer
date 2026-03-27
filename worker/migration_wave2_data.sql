-- Wave 2: 月營收 + 大盤廣度 + 美股先行指標
-- 2026-03-25

-- 月營收（每月 1-10 日更新）
CREATE TABLE IF NOT EXISTS monthly_revenue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id),
  date        TEXT NOT NULL,           -- "2026-02" 格式（年-月）
  revenue     REAL NOT NULL,           -- 當月營收（千元）
  revenue_yoy REAL,                    -- 年增率 %
  revenue_mom REAL,                    -- 月增率 %
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_monthly_revenue_stock_date ON monthly_revenue(stock_id, date);

-- 大盤廣度（每日更新）
CREATE TABLE IF NOT EXISTS market_breadth (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL UNIQUE,
  advance_count         INTEGER,       -- 上漲家數
  decline_count         INTEGER,       -- 下跌家數
  unchanged_count       INTEGER,       -- 平盤家數
  advance_ratio         REAL,          -- 上漲比例 (0-1)
  bull_alignment_pct    REAL,          -- 多頭排列比例 % (MA5>MA20>MA60)
  new_high_count        INTEGER,       -- 創 20 日新高家數
  new_low_count         INTEGER,       -- 創 20 日新低家數
  margin_balance        REAL,          -- 融資餘額（億）
  short_balance         REAL,          -- 融券餘額（張）
  margin_maintenance    REAL,          -- 整體融資維持率 %
  created_at            TEXT DEFAULT (datetime('now'))
);

-- 美股先行指標（每日 08:30 TW 更新）
CREATE TABLE IF NOT EXISTS us_market_signals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL UNIQUE,
  sox_close         REAL,              -- 費半指數收盤
  sox_return        REAL,              -- 費半日漲跌 %
  sox_ma5           REAL,              -- 費半 5 日均線
  tsm_close         REAL,              -- TSMC ADR 收盤
  tsm_return        REAL,              -- TSMC ADR 日漲跌 %
  tsm_premium       REAL,              -- ADR vs 台股溢價 %
  gspc_close        REAL,              -- S&P 500 收盤
  gspc_return       REAL,              -- S&P 500 日漲跌 %
  dxy_close         REAL,              -- 美元指數
  dxy_return        REAL,              -- 美元指數日變化 %
  hy_spread         REAL,              -- HY OAS 信用利差 (bps)
  hy_spread_chg     REAL,              -- 信用利差日變化 (bps)
  vix_close         REAL,              -- VIX 收盤
  sentiment         TEXT,              -- 'bullish' / 'neutral' / 'bearish'
  created_at        TEXT DEFAULT (datetime('now'))
);
