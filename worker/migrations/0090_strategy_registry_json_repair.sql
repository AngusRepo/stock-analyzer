-- Repair two registry rows whose JSON literals were corrupted by a manual CLI
-- statement path. The migration remains idempotent for clean installations.

UPDATE strategy_spec_registry
   SET thresholds_json='{"dsl":{"all":[{"signal":"technicalIndicators.stockTechS08RiskFilterSignal","op":">=","value":1}]}}',
       candidate_policy_json='{"poolQuota":0,"costBudget":0,"maxMlShare":0,"evidenceRequirements":["daily_adjusted_ohlcv","rsi2"]}',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id='stock_tech_s08_rsi2_risk_filter_v1'
   AND version='strategy-spec-v1';

UPDATE strategy_spec_registry
   SET thresholds_json='{"dsl":{"all":[{"signal":"technicalIndicators.stockTechS12StructureAvailable","op":">=","value":1},{"signal":"technicalIndicators.stockTechS12Signal","op":">=","value":1}]}}',
       candidate_policy_json='{"evidenceRequirements":["s12_structure_snapshots","intraday_15m","intraday_60m"],"maxMlShare":0.15}',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id='stock_tech_s12_multitimeframe_smc_reclaim_v2'
   AND version='strategy-spec-v1';
