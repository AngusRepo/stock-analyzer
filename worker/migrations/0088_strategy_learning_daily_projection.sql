-- Preserve immutable strategy decision/label evidence while serving bounded daily and lifetime projections.
CREATE TABLE IF NOT EXISTS strategy_learning_daily_stats (
  date TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  decisions INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  reward_samples INTEGER NOT NULL DEFAULT 0,
  reward_hits INTEGER NOT NULL DEFAULT 0,
  reward_sum REAL NOT NULL DEFAULT 0,
  date_portfolio_return REAL,
  reward_refresh_run_id TEXT,
  projection_version TEXT NOT NULL DEFAULT 'strategy-learning-daily-v1',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, strategy_id, strategy_version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_learning_daily_stats_strategy_date
  ON strategy_learning_daily_stats(strategy_id, strategy_version, date DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_learning_daily_stats_date
  ON strategy_learning_daily_stats(date DESC, strategy_id);

CREATE TABLE IF NOT EXISTS strategy_learning_head (
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  lifetime_decisions INTEGER NOT NULL DEFAULT 0,
  lifetime_matched INTEGER NOT NULL DEFAULT 0,
  decision_dates INTEGER NOT NULL DEFAULT 0,
  lifetime_reward_samples INTEGER NOT NULL DEFAULT 0,
  lifetime_reward_hits INTEGER NOT NULL DEFAULT 0,
  lifetime_reward_sum REAL NOT NULL DEFAULT 0,
  reward_dates INTEGER NOT NULL DEFAULT 0,
  latest_decision_date TEXT,
  latest_reward_date TEXT,
  projection_version TEXT NOT NULL DEFAULT 'strategy-learning-head-v1',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_id, strategy_version)
);

-- Historical projection rows are materialized after this schema migration with
-- bounded signal-date keyset batches. Keeping the all-history GROUP BY out of
-- the DDL migration prevents long D1 import locks and makes retries idempotent.