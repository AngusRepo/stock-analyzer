-- 執行：npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_pending_buy_debate_turns.sql

ALTER TABLE pending_buy_items ADD COLUMN debate_turns_json TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_debate_status_symbol
  ON pending_buy_items(debate_status, symbol, created_at DESC);
