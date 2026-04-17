-- migration_persona_opinions.sql — Taiwan market persona opinions (2026-04-16)
--
-- Purpose: Store daily 投信 (investment trust) and 散戶 (retail, contrarian)
-- persona opinions per stock. Computed by ml-controller's persona_service
-- after each daily ML prediction, consumed by recommendation_service (score
-- aggregation) and worker debateTrader.ts (as qualitative debate context).
--
-- Taiwan-specific persona design (not US-investor-persona transplant):
--   - 投信 (trust): secondary institution; momentum + window-dressing aware
--   - 散戶 (retail, contrarian): margin balance dynamics + concept buzz
--
-- Execute: wrangler d1 execute stockvision-db --remote --file=./worker/migration_persona_opinions.sql

CREATE TABLE IF NOT EXISTS persona_opinions (
  date                   TEXT NOT NULL,      -- trading day (TW timezone YYYY-MM-DD)
  symbol                 TEXT NOT NULL,

  -- ── 投信 agent (institutional trust) ─────────────────────────────────────
  trust_signal           TEXT,               -- 'BUY' | 'SELL' | 'NEUTRAL'
  trust_strength         REAL,               -- 0..1 confidence
  trust_reason           TEXT,               -- human-readable explanation
  trust_is_window_dress  INTEGER DEFAULT 0,  -- 1 = quarter-end window-dressing zone (strength downweighted)

  -- ── 散戶 agent (retail, contrarian) ──────────────────────────────────────
  retail_signal          TEXT,               -- 'BUY' | 'SELL' | 'NEUTRAL' | 'CAUTION'
  retail_strength        REAL,
  retail_reason          TEXT,

  -- ── Meta ─────────────────────────────────────────────────────────────────
  created_at             TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_persona_opinions_date
  ON persona_opinions(date DESC);
