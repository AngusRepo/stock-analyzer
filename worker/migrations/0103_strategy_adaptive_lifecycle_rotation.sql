-- 2026-08-05 equal-count strategy rotation and single adaptive-policy owner.
-- This migration changes lifecycle metadata only. It does not retrain, promote ML,
-- dispatch full-fit, or execute orders. Shadow strategies continue full-universe L0 labeling.
CREATE TABLE IF NOT EXISTS strategy_adaptive_policy_history_v2 (
  policy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
  knowledge_cutoff_date TEXT NOT NULL,
  strategy_weights_json TEXT NOT NULL DEFAULT '{}',
  threshold_deltas_json TEXT NOT NULL DEFAULT '{}',
  lifecycle_recommendations_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (policy_id, knowledge_cutoff_date, state_hash)
);

CREATE INDEX IF NOT EXISTS idx_strategy_adaptive_policy_history_v2_pit
  ON strategy_adaptive_policy_history_v2(policy_id, status, knowledge_cutoff_date DESC, created_at DESC);

UPDATE strategy_spec_registry
   SET status = 'active',
       owner = 'strategy',
       owner_type = 'strategy',
       promotion_status = 'production',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'alpha_miner_pymoo_nsga3_novelty_0081',
   'finlab_ai_skill_reversion_value_v1'
 );

UPDATE strategy_spec_registry
   SET status = 'shadow',
       owner = 'strategy',
       owner_type = 'strategy',
       promotion_status = 'candidate',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'stock_tech_s01_55d_trend_volume_breakout_v1',
   'stock_tech_s04_ma_deduct_turn_breakout_v1'
 );
