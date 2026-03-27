-- Migration: per-theme stock-level chip flow details
-- 每個主題下的個股法人買賣超明細（top stocks + dark horse）

CREATE TABLE IF NOT EXISTS sector_flow_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  theme TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  net_amount REAL NOT NULL,        -- 法人淨買賣超（億元）
  foreign_net REAL DEFAULT 0,      -- 外資淨買賣超（億元）
  trust_net REAL DEFAULT 0,        -- 投信淨買賣超（億元）
  volume_ratio REAL,               -- 近5日均量 / 前20日均量（黑馬用）
  classification TEXT NOT NULL DEFAULT 'top', -- 'top' | 'dark_horse'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sfs_date_theme ON sector_flow_stocks(date, theme);
CREATE INDEX IF NOT EXISTS idx_sfs_date_class ON sector_flow_stocks(date, classification);
