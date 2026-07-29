-- Depends on 0089_strategy_evaluability_and_atomic_replacement.sql.
-- Strategy selection evidence must distinguish a true no-hit from an unavailable
-- producer. Existing rows fail closed until point-in-time reconstruction.
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN evaluable INTEGER NOT NULL DEFAULT 0 CHECK(evaluable IN (0, 1));

ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN unavailable_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_evaluable
  ON strategy_label_matrix_v4(signal_date, strategy_id, evaluable, strategy_hit);
ALTER TABLE strategy_label_matrix_runs_v4
  ADD COLUMN reference_contract_version TEXT;

ALTER TABLE strategy_decision_log
  ADD COLUMN evaluation_contract_version TEXT NOT NULL DEFAULT 'strategy-evaluation-legacy-unverified';

ALTER TABLE strategy_reward_ledger
  ADD COLUMN selection_contract_version TEXT;

ALTER TABLE strategy_learning_daily_stats
  ADD COLUMN decision_contract_version TEXT;

ALTER TABLE strategy_learning_daily_stats
  ADD COLUMN reward_contract_version TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_evaluable
  ON strategy_decision_log(date, strategy_id, evaluable, matched);

CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_contract
  ON strategy_reward_ledger(selection_contract_version, strategy_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_learning_daily_decision_contract
  ON strategy_learning_daily_stats(decision_contract_version, date DESC, strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_learning_daily_reward_contract
  ON strategy_learning_daily_stats(reward_contract_version, date DESC, strategy_id);
CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_contract_date
  ON selection_reference_snapshots_v1(feature_contract_version, signal_date, symbol, producer_run_id);
-- Daily technical challengers remain candidate learning strategies. Their
-- boolean signals are materialized point-in-time; normalized scores remain
-- continuous learning evidence and never grant production weight by themselves.
UPDATE strategy_spec_registry
   SET status = 'candidate',
       owner = 'strategy',
       owner_type = 'strategy',
       promotion_status = 'candidate',
       thresholds_json = json_set(
         COALESCE(thresholds_json, '{}'),
         '$.dsl.all[0].signal', CASE strategy_id
           WHEN 'stock_tech_s03_vcp_contraction_breakout_v1' THEN 'technicalIndicators.stockTechS03Signal'
           WHEN 'stock_tech_s05_first_dry_pullback_v1' THEN 'technicalIndicators.stockTechS05Signal'
           WHEN 'stock_tech_s07_2b_false_break_reversal_v1' THEN 'technicalIndicators.stockTechS07Signal'
           WHEN 'stock_tech_s08_rsi2_bull_mean_reversion_v1' THEN 'technicalIndicators.stockTechS08Signal'
           WHEN 'stock_tech_s09_three_soldiers_base_breakout_v1' THEN 'technicalIndicators.stockTechS09Signal'
           WHEN 'stock_tech_s10_island_reversal_v1' THEN 'technicalIndicators.stockTechS10Signal'
         END,
         '$.dsl.all[0].op', '==',
         '$.dsl.all[0].value', 1,
         '$.technicalStrategy.requiresMaterializedSignal', CASE strategy_id
           WHEN 'stock_tech_s03_vcp_contraction_breakout_v1' THEN 'technicalIndicators.stockTechS03Signal'
           WHEN 'stock_tech_s05_first_dry_pullback_v1' THEN 'technicalIndicators.stockTechS05Signal'
           WHEN 'stock_tech_s07_2b_false_break_reversal_v1' THEN 'technicalIndicators.stockTechS07Signal'
           WHEN 'stock_tech_s08_rsi2_bull_mean_reversion_v1' THEN 'technicalIndicators.stockTechS08Signal'
           WHEN 'stock_tech_s09_three_soldiers_base_breakout_v1' THEN 'technicalIndicators.stockTechS09Signal'
           WHEN 'stock_tech_s10_island_reversal_v1' THEN 'technicalIndicators.stockTechS10Signal'
         END
       ),
       candidate_policy_json = json_set(COALESCE(candidate_policy_json, '{}'), '$.maxMlShare', 0),
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'stock_tech_s03_vcp_contraction_breakout_v1',
   'stock_tech_s05_first_dry_pullback_v1',
   'stock_tech_s07_2b_false_break_reversal_v1',
   'stock_tech_s08_rsi2_bull_mean_reversion_v1',
   'stock_tech_s09_three_soldiers_base_breakout_v1',
   'stock_tech_s10_island_reversal_v1'
 );
-- S12 is the intraday execution-edge owner. Its formal evidence is persisted in
-- s12_structure_snapshots after L1 selection and belongs to S12/Fusion, not to
-- the immutable same-run selection matrix.
UPDATE strategy_spec_registry
   SET status = 'research',
       owner = 'feature',
       owner_type = 'feature',
       promotion_status = 'research',
       thesis = 'Intraday S12 execution evidence owner backed by s12_structure_snapshots; excluded from same-run L1 selection admission.',
       candidate_policy_json = json_set(COALESCE(candidate_policy_json, '{}'), '$.maxMlShare', 0),
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s12_multitimeframe_smc_reclaim_v1';