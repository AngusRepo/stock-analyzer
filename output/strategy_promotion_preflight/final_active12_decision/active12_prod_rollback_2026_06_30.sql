-- Rollback Active12 final cutover to the pre-cutover active11 registry state.
-- Apply only if post-prod verification fails.

UPDATE strategy_spec_registry
   SET status='active',
       promotion_status='production',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'alpha_miner_pymoo_nsga3_novelty_0193',
   'alphabuilders_multifactor_revenue_quality_momentum_v1',
   'breakout_vol_expansion_seed_v1',
   'defensive_accumulation_seed_v1',
   'finlab_ai_skill_broker_accumulation_reclaim_v1',
   'stock_tech_s01_55d_trend_volume_breakout_v1',
   'stock_tech_s02_52w_dual_momentum_v1',
   'stock_tech_s04_ma_deduct_turn_breakout_v1',
   'stock_tech_s06_nr7_inside_bar_breakout_v1',
   'stock_tech_s11_gap_breakout_continuation_v1',
   'trend_following_seed_v1'
 );

UPDATE strategy_spec_registry
   SET status='retired',
       promotion_status='retired',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'trend_quality_breakout_fused_v1',
   'alpha223_0248',
   'alpha223_0109',
   'alpha223_0166',
   'alpha223_0283',
   'alpha223_0009'
 );
