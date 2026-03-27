-- Paper Trading 動態出場系統 v2
-- 三層動態止損 + 分批停利 + Chandelier Trailing Stop

ALTER TABLE paper_positions ADD COLUMN entry_price REAL;
ALTER TABLE paper_positions ADD COLUMN entry_date TEXT;
ALTER TABLE paper_positions ADD COLUMN initial_stop REAL;
ALTER TABLE paper_positions ADD COLUMN trailing_stop REAL;
ALTER TABLE paper_positions ADD COLUMN highest_since_entry REAL;
ALTER TABLE paper_positions ADD COLUMN stop_multiplier REAL DEFAULT 2.0;
ALTER TABLE paper_positions ADD COLUMN tp1_price REAL;
ALTER TABLE paper_positions ADD COLUMN tp2_price REAL;
ALTER TABLE paper_positions ADD COLUMN tp1_hit INTEGER DEFAULT 0;
ALTER TABLE paper_positions ADD COLUMN original_shares INTEGER;

-- Backfill existing positions（若有既有持倉）
UPDATE paper_positions
SET entry_price = avg_cost,
    entry_date = updated_at,
    highest_since_entry = avg_cost,
    original_shares = shares,
    initial_stop = avg_cost * 0.93,
    trailing_stop = avg_cost * 0.93,
    tp1_price = avg_cost * 1.03,
    tp2_price = avg_cost * 1.06
WHERE entry_price IS NULL;
