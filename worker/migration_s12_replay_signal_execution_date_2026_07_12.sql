-- Canonical replay v2 separates the post-close recommendation date from the
-- next stock-specific executable session. Legacy same-day rows remain for
-- audit but are excluded from Fusion training because signal_date stays NULL.
ALTER TABLE s12_replay_trade_outcomes ADD COLUMN signal_date TEXT;

CREATE INDEX IF NOT EXISTS idx_s12_replay_trade_outcomes_signal_date
  ON s12_replay_trade_outcomes(signal_date DESC, sample_eligible, symbol);

CREATE UNIQUE INDEX IF NOT EXISTS idx_s12_replay_trade_outcomes_signal_setup_v2
  ON s12_replay_trade_outcomes(symbol, signal_date, setup_id)
  WHERE signal_date IS NOT NULL;
