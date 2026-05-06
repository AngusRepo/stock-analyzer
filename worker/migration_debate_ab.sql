-- ─── #44 W5 Debate A/B log (2026-04-21) ──────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_debate_ab.sql
--
-- Each buy-debate invocation records (symbol, model used, verdict, conviction,
-- summary len) so Wei can compare Claude vs Gemini later via SQL without
-- touching the debate path again.
--
-- Routing: deterministic hash(symbol + date) % 2 — same symbol always gets
-- same model for given day (consistency for within-day restarts), rotates
-- across days for fair distribution.

CREATE TABLE IF NOT EXISTS debate_ab_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  date              TEXT NOT NULL,              -- TW YYYY-MM-DD
  symbol            TEXT NOT NULL,
  model_assigned    TEXT NOT NULL,              -- 'gemini' | 'anthropic'
  model_actual      TEXT,                       -- what actually served (fallback awareness)
  verdict           TEXT,                       -- 'BUY' | 'HOLD' | 'DOWNGRADE' | etc.
  conviction_score  REAL,
  summary_len       INTEGER,
  debate_rounds     INTEGER,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  meta              TEXT                        -- JSON blob for context
);

CREATE INDEX IF NOT EXISTS idx_debate_ab_date   ON debate_ab_log(date DESC);
CREATE INDEX IF NOT EXISTS idx_debate_ab_model  ON debate_ab_log(model_assigned, date DESC);
CREATE INDEX IF NOT EXISTS idx_debate_ab_symbol ON debate_ab_log(symbol, date DESC);
