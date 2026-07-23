-- A canonical reward refresh owns the current ledger generation.
ALTER TABLE strategy_reward_ledger ADD COLUMN refresh_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_refresh
  ON strategy_reward_ledger(refresh_run_id, date_end);
