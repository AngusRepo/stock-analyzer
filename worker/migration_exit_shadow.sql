-- ─── #16 Step 9c / #30 Step 9 — Exit-cascade regime shadow persistence ─────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_exit_shadow.sql
--
-- Why this exists (2026-04-21):
--   paper.ts logRegimeShadow() 已從 4/20 起把 hypothetical dynamicExitPriority
--   reorder/multiplier 印到 Worker log (console.log)。但 Cloudflare Workers log
--   無持久化（Logpush/Observability 未啟用），4/27 Wei 翻
--   `exit.dynamicExitPriorityEnabled` flag 的 A/B review 需要歷史資料。
--   此表供 logRegimeShadow 同步 insert，analyze script 可直接 SQL aggregate。

CREATE TABLE IF NOT EXISTS exit_shadow_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL,            -- ISO timestamp (UTC)
  date                TEXT NOT NULL,            -- TW date YYYY-MM-DD (derived at insert)
  caller              TEXT NOT NULL,            -- 'runEODExit' | 'forceDayTradeClose' | 'pollIntradayStopLoss'
  symbol              TEXT NOT NULL,
  regime              TEXT NOT NULL,            -- 'bull' | 'bear' | 'volatile' | 'sideways'
  actual_action       TEXT NOT NULL,            -- 'full_sell' | 'half_sell' | 'hold' | ...
  actual_reason       TEXT,                     -- free-form reason string from ExitDecision
  hypothetical_order  TEXT,                     -- JSON array of layer names in regime-suggested order
  hypothetical_mult   TEXT                      -- JSON: {hardStop, atrTrail, tp1, tp2, timeStop}
);

CREATE INDEX IF NOT EXISTS idx_exit_shadow_date   ON exit_shadow_log(date DESC);
CREATE INDEX IF NOT EXISTS idx_exit_shadow_regime ON exit_shadow_log(regime, date DESC);
CREATE INDEX IF NOT EXISTS idx_exit_shadow_symbol ON exit_shadow_log(symbol, date DESC);
