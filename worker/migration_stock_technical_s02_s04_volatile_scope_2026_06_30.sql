-- Allow active S02/S04 technical admission strategies to contribute during
-- volatile regimes. The daily admission gate remains fail-closed on
-- stockTechS02Admission/stockTechS04Admission, so this only repairs the
-- L1.5 regime ownership block that prevented valid admissions from receiving
-- final strategy attribution.
--
-- Apply after deploy approval:
--   cd worker
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./migration_stock_technical_s02_s04_volatile_scope_2026_06_30.sql

UPDATE strategy_spec_registry
   SET supported_regimes_json = '["bull","sideways","volatile"]',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS02Signal remains stronger entry evidence, not the only admission path.","S2 momentum uses 12-1 momentum with a 252-bar fallback to avoid off-by-one empty coverage.","2026-06-30 repair: volatile regime is allowed because production attribution is guarded by materialized stockTechS02Admission, not raw regime-only exposure."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s02_52w_dual_momentum_v1'
   AND status = 'active';

UPDATE strategy_spec_registry
   SET supported_regimes_json = '["bull","sideways","volatile"]',
       risk_notes_json = '["Active runtime gate uses adaptive score-priority admission; strict stockTechS04Signal remains stronger entry evidence, not the only admission path.","Runtime matching should prefer materialized admission over hard signal-only trigger.","2026-06-30 repair: volatile regime is allowed because production attribution is guarded by materialized stockTechS04Admission, not raw regime-only exposure."]',
       updated_at = datetime('now')
 WHERE strategy_id = 'stock_tech_s04_ma_deduct_turn_breakout_v1'
   AND status = 'active';
