-- ─── #16 Sector leaders cache (dannyquant_tw 啟發) ──────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_sector_leaders.sql
--
-- Why this exists (2026-04-21):
--   Each weekly cron (Sat 22:30 UTC / Sun 06:30 TW) computes top-3 stocks per
--   sector by 60d avg turnover (proxy for institutional attention / liquidity).
--   Screener candidates then score a bonus for high 60d return correlation with
--   their sector leaders (dannyquant_tw insight: 族群連動 is a persistent edge).
--
-- Overwrite semantics: computeSectorLeaders DELETE-then-INSERT per run.

CREATE TABLE IF NOT EXISTS sector_leaders (
  sector            TEXT NOT NULL,
  rank              INTEGER NOT NULL,        -- 1, 2, 3 (top 3)
  stock_id          INTEGER,
  symbol            TEXT NOT NULL,
  avg_turnover_60d  REAL,                    -- avg(close*volume) over last 60 trading days
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (sector, rank)
);

CREATE INDEX IF NOT EXISTS idx_sector_leaders_symbol ON sector_leaders(symbol);
