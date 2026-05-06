-- migration_debate_memory.sql — 2026-04-20 #18 FinMem 分層記憶
--
-- Purpose: 儲存每日 debate 結論供下次 debate 注入 prompt（解 narrative drift）
--   - 同 symbol 近 7d/30d/90d thesis 查 date range 即可（不需 layer column）
--   - 同 sector peers 近 7d thesis 可透過 JOIN stock_tags 取得
--
-- 寫入時機：debateTrader runBuyDebate 完成 → INSERT 一筆
-- 讀取時機：debateTrader buildDebatePrompt → SELECT 最近 N 筆
-- 清理：daily cron 刪 > 90d 舊 row（見 worker cron runDebateMemoryRetention）

CREATE TABLE IF NOT EXISTS debate_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  debate_date TEXT NOT NULL,       -- YYYY-MM-DD (TW local)
  thesis_summary TEXT NOT NULL,    -- ≤200 字 debate 結論
  direction TEXT NOT NULL,         -- 'bullish' | 'bearish' | 'neutral'
  key_factors TEXT,                -- JSON array string, e.g. '["外資連買","MA20突破"]'
  verdict TEXT,                    -- 'APPROVE' | 'DOWNGRADE' | 'REJECT'
  conviction_score INTEGER,        -- 0-100 judge 信念度
  llm_source TEXT,                 -- 'tunnel' | 'gemini_api' | 'anthropic_api'
  created_at TEXT NOT NULL         -- ISO8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_debate_memory_sym_date ON debate_memory(symbol, debate_date DESC);
CREATE INDEX IF NOT EXISTS idx_debate_memory_date     ON debate_memory(debate_date);
