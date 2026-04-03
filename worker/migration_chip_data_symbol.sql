-- migration: chip_data stock_id (INTEGER FK) → symbol (TEXT)
-- Why: M13 教訓 — stock_id FK 造成 symbol 混淆；新股票無歷史籌碼
-- Step 1: Create new table with symbol TEXT instead of stock_id FK
-- Step 2: Copy data with JOIN to resolve symbol
-- Step 3: Drop old table, rename new

-- 1. New schema
CREATE TABLE chip_data_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  date           TEXT NOT NULL,
  foreign_buy    INTEGER, foreign_sell INTEGER, foreign_net INTEGER,
  trust_buy      INTEGER, trust_sell   INTEGER, trust_net   INTEGER,
  dealer_buy     INTEGER, dealer_sell  INTEGER, dealer_net  INTEGER,
  margin_balance INTEGER,
  short_balance  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, date)
);

-- 2. Copy existing data (resolve stock_id → symbol via JOIN)
INSERT INTO chip_data_new (symbol, date, foreign_buy, foreign_sell, foreign_net, trust_buy, trust_sell, trust_net, dealer_buy, dealer_sell, dealer_net, margin_balance, short_balance, created_at)
SELECT s.symbol, c.date, c.foreign_buy, c.foreign_sell, c.foreign_net, c.trust_buy, c.trust_sell, c.trust_net, c.dealer_buy, c.dealer_sell, c.dealer_net, c.margin_balance, c.short_balance, c.created_at
FROM chip_data c
JOIN stocks s ON c.stock_id = s.id;

-- 3. Drop old table + rename
DROP TABLE chip_data;
ALTER TABLE chip_data_new RENAME TO chip_data;

-- 4. Recreate index
CREATE INDEX idx_chip_symbol_date ON chip_data(symbol, date);
