-- Repair active stock technical strategy gates after runtime signal materialization.
-- The score is continuous 0..1 evidence; StrategySpec matching should use the
-- boolean FinLab-style signal gate.
-- Apply after deploy/replay approval:
--   cd worker
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./migration_stock_technical_active_signal_gate_2026_06_26.sql

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS01Signal","op":"==","value":1}]},"technicalStrategy":{"id":"S1","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedSignal":"technicalIndicators.stockTechS01Signal","scoreSignal":"technicalIndicators.stockTechS01Score"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_price_structure","raw_volume","materialized_signal:stockTechS01Signal","materialized_score:stockTechS01Score"],"maxMlShare":0}',
       risk_notes_json = '["Candidate only. FinLab research benchmark required before paper-active approval.","Runtime matching is fail-closed until stockTechS01Signal and stockTechS01Score are materialized into raw_signals."]',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s01_55d_trend_volume_breakout_v1'
   AND version = 'strategy-spec-v1';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS02Signal","op":"==","value":1}]},"technicalStrategy":{"id":"S2","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedSignal":"technicalIndicators.stockTechS02Signal","scoreSignal":"technicalIndicators.stockTechS02Score"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_momentum","monthly_rebalance","materialized_signal:stockTechS02Signal","materialized_score:stockTechS02Score"],"maxMlShare":0}',
       risk_notes_json = '["Candidate only. Monthly strategy; compare separately from daily event strategies.","Runtime matching is fail-closed until stockTechS02Signal and stockTechS02Score are materialized into raw_signals."]',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s02_52w_dual_momentum_v1'
   AND version = 'strategy-spec-v1';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS04Signal","op":"==","value":1}]},"technicalStrategy":{"id":"S4","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedSignal":"technicalIndicators.stockTechS04Signal","scoreSignal":"technicalIndicators.stockTechS04Score"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_price_structure","raw_volume","materialized_signal:stockTechS04Signal","materialized_score:stockTechS04Score"],"maxMlShare":0}',
       risk_notes_json = '["Candidate only. FinLab benchmark is research-only, not a promotion gate override.","Runtime matching is fail-closed until stockTechS04Signal and stockTechS04Score are materialized into raw_signals."]',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s04_ma_deduct_turn_breakout_v1'
   AND version = 'strategy-spec-v1';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS06Signal","op":"==","value":1}]},"technicalStrategy":{"id":"S6","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedSignal":"technicalIndicators.stockTechS06Signal","scoreSignal":"technicalIndicators.stockTechS06Score"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_price_structure","raw_volume","materialized_signal:stockTechS06Signal","materialized_score:stockTechS06Score"],"maxMlShare":0}',
       risk_notes_json = '["Candidate only. Needs slippage review because signals are breakout-at-open sensitive.","Runtime matching is fail-closed until stockTechS06Signal and stockTechS06Score are materialized into raw_signals."]',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s06_nr7_inside_bar_breakout_v1'
   AND version = 'strategy-spec-v1';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS11Signal","op":"==","value":1}]},"technicalStrategy":{"id":"S11","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedSignal":"technicalIndicators.stockTechS11Signal","scoreSignal":"technicalIndicators.stockTechS11Score"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_gap_pattern","raw_volume","materialized_signal:stockTechS11Signal","materialized_score:stockTechS11Score"],"maxMlShare":0}',
       risk_notes_json = '["Candidate only. Gap execution requires open/slippage validation before paper-active.","Runtime matching is fail-closed until stockTechS11Signal and stockTechS11Score are materialized into raw_signals."]',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s11_gap_breakout_continuation_v1'
   AND version = 'strategy-spec-v1';
