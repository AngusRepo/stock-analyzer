-- T+2 Net Settlement for Paper Trading
-- 台股 T+2 淨額交割：買賣不立即結算，T+2 business day 才真正結算
CREATE TABLE IF NOT EXISTS paper_settlements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL,
  order_id        INTEGER NOT NULL,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  amount          REAL NOT NULL,
  trade_date      TEXT NOT NULL,
  settlement_date TEXT NOT NULL,
  settled         INTEGER NOT NULL DEFAULT 0,
  settled_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_settlements_pending ON paper_settlements(settled, settlement_date);
CREATE INDEX IF NOT EXISTS idx_settlements_account ON paper_settlements(account_id, settled);
