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

INSERT INTO strategy_learning_daily_stats (
  date, strategy_id, strategy_version, decisions, matched, updated_at
)
SELECT date,
       strategy_id,
       strategy_version,
       COUNT(*) AS decisions,
       SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) AS matched,
       CURRENT_TIMESTAMP
  FROM strategy_decision_log
 WHERE 1 = 1
 GROUP BY date, strategy_id, strategy_version
ON CONFLICT(date, strategy_id, strategy_version) DO UPDATE SET
  decisions=excluded.decisions,
  matched=excluded.matched,
  updated_at=excluded.updated_at;

INSERT INTO strategy_learning_daily_stats (
  date,
  strategy_id,
  strategy_version,
  reward_samples,
  reward_hits,
  reward_sum,
  date_portfolio_return,
  reward_refresh_run_id,
  updated_at
)
SELECT m.signal_date,
       m.strategy_id,
       m.strategy_version,
       COUNT(*) AS reward_samples,
       SUM(CASE WHEN CAST(l.residual_return_net AS REAL) > 0 THEN 1 ELSE 0 END) AS reward_hits,
       SUM(CAST(l.residual_return_net AS REAL)) AS reward_sum,
       AVG(CAST(l.residual_return_net AS REAL)) AS date_portfolio_return,
       'migration-0088-backfill',
       CURRENT_TIMESTAMP
  FROM strategy_label_matrix_v4 m
  JOIN selection_reference_snapshots_v1 r
    ON r.signal_date = m.signal_date
   AND r.symbol = m.symbol
   AND r.producer_run_id = m.producer_run_id
  JOIN canonical_selection_labels_v4 l
    ON l.signal_date = m.signal_date
   AND l.symbol = m.symbol
   AND l.producer_run_id = m.producer_run_id
 WHERE m.strategy_hit = 1
   AND l.label_schema_version = 'canonical-strategy-selection-label-v4'
   AND l.residual_return_net IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM canonical_run_heads h
      WHERE h.logical_run_key = 'screener:' || m.signal_date || ':TW:production:market_screener'
        AND h.run_id = m.producer_run_id
   )
 GROUP BY m.signal_date, m.strategy_id, m.strategy_version
ON CONFLICT(date, strategy_id, strategy_version) DO UPDATE SET
  reward_samples=excluded.reward_samples,
  reward_hits=excluded.reward_hits,
  reward_sum=excluded.reward_sum,
  date_portfolio_return=excluded.date_portfolio_return,
  reward_refresh_run_id=excluded.reward_refresh_run_id,
  updated_at=excluded.updated_at;

INSERT INTO strategy_learning_head (
  strategy_id,
  strategy_version,
  lifetime_decisions,
  lifetime_matched,
  decision_dates,
  lifetime_reward_samples,
  lifetime_reward_hits,
  lifetime_reward_sum,
  reward_dates,
  latest_decision_date,
  latest_reward_date,
  updated_at
)
SELECT strategy_id,
       strategy_version,
       SUM(decisions),
       SUM(matched),
       COUNT(DISTINCT CASE WHEN decisions > 0 THEN date END),
       SUM(reward_samples),
       SUM(reward_hits),
       SUM(reward_sum),
       COUNT(DISTINCT CASE WHEN reward_samples > 0 THEN date END),
       MAX(CASE WHEN decisions > 0 THEN date END),
       MAX(CASE WHEN reward_samples > 0 THEN date END),
       CURRENT_TIMESTAMP
  FROM strategy_learning_daily_stats
 GROUP BY strategy_id, strategy_version
ON CONFLICT(strategy_id, strategy_version) DO UPDATE SET
  lifetime_decisions=excluded.lifetime_decisions,
  lifetime_matched=excluded.lifetime_matched,
  decision_dates=excluded.decision_dates,
  lifetime_reward_samples=excluded.lifetime_reward_samples,
  lifetime_reward_hits=excluded.lifetime_reward_hits,
  lifetime_reward_sum=excluded.lifetime_reward_sum,
  reward_dates=excluded.reward_dates,
  latest_decision_date=excluded.latest_decision_date,
  latest_reward_date=excluded.latest_reward_date,
  updated_at=excluded.updated_at;