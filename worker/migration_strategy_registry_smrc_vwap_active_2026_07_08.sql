-- Promote SMRCVWAP daily StrategySpec from candidate to active production.
-- This only changes L1 daily strategy selection; S12/intraday execution gates remain unchanged.
UPDATE strategy_spec_registry
   SET status = 'active',
       owner_type = 'strategy',
       promotion_status = 'production',
       risk_notes_json = '["Active daily strategy; does not alter S12/intraday execution mechanics.","Backtest VWAP uses daily OHLCV proxy and must not be interpreted as byte-identical intraday VWAP.","Threshold sensitivity selected calibratedMin=0.74 because 0.80/0.86 narrowed breadth but degraded Sharpe and max drawdown.","Production promotion approved on 2026-07-08; monitor forward matched trades and strategy reward ledger for active cooldown."]',
       source_refs_json = '["strategy_spec:data/strategy_specs/smrc_vwap_reclaim_v1_active.json","calibration:data/strategy_calibrations/smrc_vwap_reclaim_v1_threshold_selection_20260707.json","finlab_runner:tools/finlab_strategy_spec_backtest.py","registry_promotion:20260708"]',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'smrc_vwap_reclaim_v1'
   AND version = 'strategy-spec-v1';
