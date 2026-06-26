-- Promote stock technical active runtime gates from hard entry triggers to
-- adaptive materialized admissions. Signal remains the strict FinLab-style
-- trigger evidence; Admission is signal OR score-priority near-miss selected
-- by the daily universe materializer.

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS01Admission","op":"==","value":1}]},"technicalStrategy":{"id":"S1","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedAdmission":"technicalIndicators.stockTechS01Admission","requiresMaterializedSignal":"technicalIndicators.stockTechS01Signal","scoreSignal":"technicalIndicators.stockTechS01Score","admissionPolicy":"adaptive_score_priority_or_hard_signal"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_price_structure","raw_volume","materialized_admission:stockTechS01Admission","materialized_signal:stockTechS01Signal","materialized_score:stockTechS01Score"],"maxMlShare":0}',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS01Signal remains stronger entry evidence, not the only admission path.","FinLab research benchmark remains evidence; runtime admission is materialized daily from live universe scores."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s01_55d_trend_volume_breakout_v1'
   AND status = 'active';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS02Admission","op":"==","value":1}]},"technicalStrategy":{"id":"S2","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedAdmission":"technicalIndicators.stockTechS02Admission","requiresMaterializedSignal":"technicalIndicators.stockTechS02Signal","scoreSignal":"technicalIndicators.stockTechS02Score","admissionPolicy":"adaptive_score_priority_or_hard_signal"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_momentum","monthly_rebalance","materialized_admission:stockTechS02Admission","materialized_signal:stockTechS02Signal","materialized_score:stockTechS02Score"],"maxMlShare":0}',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS02Signal remains stronger entry evidence, not the only admission path.","S2 momentum uses 12-1 momentum with a 252-bar fallback to avoid off-by-one empty coverage."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s02_52w_dual_momentum_v1'
   AND status = 'active';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS04Admission","op":"==","value":1}]},"technicalStrategy":{"id":"S4","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedAdmission":"technicalIndicators.stockTechS04Admission","requiresMaterializedSignal":"technicalIndicators.stockTechS04Signal","scoreSignal":"technicalIndicators.stockTechS04Score","admissionPolicy":"adaptive_score_priority_or_hard_signal"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_price_structure","raw_volume","materialized_admission:stockTechS04Admission","materialized_signal:stockTechS04Signal","materialized_score:stockTechS04Score"],"maxMlShare":0}',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS04Signal remains stronger entry evidence, not the only admission path.","Runtime matching should prefer materialized admission over hard signal-only trigger."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s04_ma_deduct_turn_breakout_v1'
   AND status = 'active';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS06Admission","op":"==","value":1}]},"technicalStrategy":{"id":"S6","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedAdmission":"technicalIndicators.stockTechS06Admission","requiresMaterializedSignal":"technicalIndicators.stockTechS06Signal","scoreSignal":"technicalIndicators.stockTechS06Score","admissionPolicy":"adaptive_score_priority_or_hard_signal"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_price_structure","raw_volume","materialized_admission:stockTechS06Admission","materialized_signal:stockTechS06Signal","materialized_score:stockTechS06Score"],"maxMlShare":0}',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS06Signal remains stronger entry evidence, not the only admission path.","Breakout-sensitive execution still requires intraday quote sanity before paper fills."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s06_nr7_inside_bar_breakout_v1'
   AND status = 'active';

UPDATE strategy_spec_registry
   SET thresholds_json = '{"minPrice":10,"dsl":{"all":[{"signal":"technicalIndicators.stockTechS11Admission","op":"==","value":1}]},"technicalStrategy":{"id":"S11","sourceSpec":"C:/Users/Wei/Downloads/stock_technical_strategies_12_complete_spec.md","requiresMaterializedAdmission":"technicalIndicators.stockTechS11Admission","requiresMaterializedSignal":"technicalIndicators.stockTechS11Signal","scoreSignal":"technicalIndicators.stockTechS11Score","admissionPolicy":"adaptive_score_priority_or_hard_signal"}}',
       candidate_policy_json = '{"poolQuota":10,"costBudget":12,"evidenceRequirements":["technical_strategy12","finlab_backtest","raw_gap_pattern","raw_volume","materialized_admission:stockTechS11Admission","materialized_signal:stockTechS11Signal","materialized_score:stockTechS11Score"],"maxMlShare":0}',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS11Signal remains stronger entry evidence, not the only admission path.","Gap continuation execution still requires open/slippage validation before paper fills."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s11_gap_breakout_continuation_v1'
   AND status = 'active';
