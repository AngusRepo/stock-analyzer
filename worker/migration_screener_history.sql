-- ─── #15 Screener selection history (dannyquant_tw 啟發) ────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_screener_history.sql
--
-- Why this exists (2026-04-21):
--   Track per-day screener selection → compute 兩類 behavioral flag:
--     high_freq  — 過去 20 天被選中 ≥ 12 次 (institutional attention signal)
--     new_money  — 過去 30 天內首次被選中今日 (breakout candidate)
--   Forward-only：deploy 日起累積，20d 後 high_freq 開始成熟，30d 後 new_money
--   可信度達標。Screener `finalCandidates` 寫 daily_recommendations 前同批 insert
--   此表，fire-and-forget（錯誤不擋 screener 主流程）。

CREATE TABLE IF NOT EXISTS screener_selection_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,              -- TW YYYY-MM-DD
  stock_id   INTEGER,                    -- FK stocks.id (nullable: 若 stock 未建立不強制)
  symbol     TEXT NOT NULL,              -- 同時記 symbol 方便 query 不需 join
  score      REAL,                       -- combined screener score (chip+tech+momentum)
  industry   TEXT,
  UNIQUE(date, symbol)                   -- 防止同日重複 insert
);

CREATE INDEX IF NOT EXISTS idx_screener_hist_date   ON screener_selection_history(date DESC);
CREATE INDEX IF NOT EXISTS idx_screener_hist_symbol ON screener_selection_history(symbol, date DESC);
