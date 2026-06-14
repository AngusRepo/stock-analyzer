-- ─── #43 Cost Tracking API (2026-04-21) ──────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_cost_events.sql
--
-- Root cause for this table (ship-day): QuantaAlpha POC 4h mine cycle burned
-- $1.43+ Ephemeral Apps + unknown persistent App charge with ZERO visibility
-- until Wei checked Modal billing dashboard. All production LLM calls +
-- Modal invocations should record here so Wei can see daily / monthly spend
-- and set alert thresholds.

CREATE TABLE IF NOT EXISTS cost_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,              -- ISO UTC timestamp
  date            TEXT NOT NULL,              -- TW YYYY-MM-DD (derived)
  source          TEXT NOT NULL,              -- 'llm_reason' | 'llm_debate' | 'llm_newsanalyst' | 'modal_function' | 'manual'
  provider        TEXT,                       -- 'anthropic' | 'gemini' | 'deepseek' | 'modal' | ...
  model           TEXT,                       -- e.g. 'claude-sonnet-4-6', 'gemini-3.5-flash', 'run_mine_cycle'
  tokens_in       INTEGER,                    -- null for non-LLM
  tokens_out      INTEGER,
  compute_sec     REAL,                       -- Modal function runtime (null for LLM)
  est_usd         REAL NOT NULL,              -- estimated cost in USD
  meta            TEXT                        -- freeform JSON blob (call_id / cycle / stock / ...)
);

CREATE INDEX IF NOT EXISTS idx_cost_events_date     ON cost_events(date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_source   ON cost_events(source, date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_provider ON cost_events(provider, date DESC);

-- Daily rollup view for fast dashboard query (D1 supports VIEW)
CREATE VIEW IF NOT EXISTS cost_daily AS
  SELECT date, source, provider, model,
         COUNT(*) AS calls,
         SUM(COALESCE(tokens_in, 0))  AS tokens_in_total,
         SUM(COALESCE(tokens_out, 0)) AS tokens_out_total,
         SUM(COALESCE(compute_sec, 0)) AS compute_sec_total,
         ROUND(SUM(est_usd), 4) AS est_usd_total
  FROM cost_events
  GROUP BY date, source, provider, model;
