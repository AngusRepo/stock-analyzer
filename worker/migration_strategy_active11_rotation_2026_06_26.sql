-- StockVision active strategy rotation after active11/candidate12 FinLab audit.
-- Keeps demoted rows in the runtime strategy pool as candidates; retired rows remain excluded.
-- Apply after migration_stock_technical_strategy12_challengers_2026_06_25.sql.

UPDATE strategy_spec_registry
   SET status = 'candidate',
       promotion_status = 'candidate',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'alpha_miner_pymoo_nsga3_novelty_0081',
   'alpha_miner_pymoo_nsga3_novelty_0187',
   'finlab_ai_skill_quality_trend_v1',
   'finlab_ai_skill_revenue_revision_breakout_v1',
   'finlab_ai_skill_reversion_value_v1'
 );

UPDATE strategy_spec_registry
   SET status = 'active',
       promotion_status = 'production',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'stock_tech_s01_55d_trend_volume_breakout_v1',
   'stock_tech_s02_52w_dual_momentum_v1',
   'stock_tech_s04_ma_deduct_turn_breakout_v1',
   'stock_tech_s06_nr7_inside_bar_breakout_v1',
   'stock_tech_s11_gap_breakout_continuation_v1'
 );
