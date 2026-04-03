-- 興櫃股均價欄位：興櫃的漲跌幅基準是前日均價，不是收盤價
-- watchlist change_pct 改用 COALESCE(avg_price, close) 計算
ALTER TABLE stock_prices ADD COLUMN avg_price REAL;
