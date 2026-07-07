-- StockVision SMRCVWAP daily StrategySpec candidate.
-- Candidate registry only; does not promote to production active and does not change S12/intraday execution gates.
INSERT INTO strategy_spec_registry (
  strategy_id, version, name, status, owner, alpha_bucket, family_id, variant_id,
  owner_type, promotion_status, supported_regimes_json, thesis, thresholds_json,
  candidate_policy_json, risk_notes_json, source_refs_json, created_by, created_at, updated_at
)
VALUES (
  'smrc_vwap_reclaim_v1',
  'strategy-spec-v1',
  'SMRC VWAP daily reclaim',
  'candidate',
  'strategy',
  'breakout_vol_expansion',
  'SMC_STRUCTURE_RECLAIM',
  'daily_smc_vwap_reclaim_v1',
  'strategy',
  'candidate',
  '["bull","sideways","volatile"]',
  'Daily SMC structure reclaim plus VWAP bias setup. This strategy selects daily candidates only; existing S12/intraday gates remain responsible for execution timing.',
  '{"minPrice":10,"minVolumeExpansion20":0.6,"featureRefs":{"all":[{"featureRef":"vwap_bias","signal":"factorSignals.vwap_bias","op":">=","value":-0.005},{"featureRef":"vwap_bias_5d","signal":"factorSignals.vwap_bias_5d","op":">=","value":-0.01},{"featureRef":"l1_smcNetScore","signal":"technicalIndicators.smcNetScore","op":">=","value":0}],"not":[{"featureRef":"smcBiasBearish","signal":"technicalIndicators.smcBiasBearish","op":"==","value":1}],"weightedScore":{"min":0.58,"terms":[{"featureRef":"vwap_bias","signal":"factorSignals.finlabCsVwapBiasRank","weight":0.28},{"featureRef":"vwap_bias_5d","signal":"factorSignals.finlabCsVwapBias5dRank","weight":0.22},{"featureRef":"l1_bestOrderBlockStrength","signal":"factorSignals.finlabCsBestOrderBlockStrengthRank","weight":0.25},{"featureRef":"l1_volumeExpansion20","signal":"factorSignals.finlabCsVolumeExpansion20Rank","weight":0.15},{"featureRef":"l1_smcBullishScore","signal":"technicalIndicators.smcBullishScore","weight":0.1}],"calibration":{"schemaVersion":"strategy-feature-ref-weighted-score-calibration-v1","calibrationId":"smrc_vwap_reclaim_v1:threshold-sensitivity:v20260707","status":"active","method":"threshold_sensitivity_backtest","originalMin":0.58,"calibratedMin":0.74,"validationFold":{"startDate":"2023-01-01","endDate":"2026-06-15"},"targetDailyMatches":160,"observed":{"validationRows":830,"validationCompleteFeatureRows":830,"validationMatchesAtOriginalMin":301,"validationMatchesAtCalibratedMin":135,"holdoutDate":"2026-06-15","holdoutMatchesAtCalibratedMin":180},"sourceRefs":["data/strategy_calibrations/smrc_vwap_reclaim_v1_threshold_selection_20260707.json","output/finlab_strategy_backtests_smrc_vwap/finlab_strategy_spec_runtime1_20230101_20260615.csv"],"frozenAt":"2026-07-07T00:00:00Z"}}}}',
  '{"poolQuota":8,"costBudget":12,"evidenceRequirements":["daily_vwap_proxy","smc_structure_reclaim","finlab_strategy_spec_backtest","intraday_s12_execution_gate_unchanged"],"maxMlShare":0.18}',
  '["Candidate only; does not alter S12/intraday execution mechanics.","Backtest VWAP uses daily OHLCV proxy and must not be interpreted as byte-identical intraday VWAP.","Threshold sensitivity selected calibratedMin=0.74 because 0.80/0.86 narrowed breadth but degraded Sharpe and max drawdown.","Promote only after FinLab replay plus paper execution evidence show positive forward edge and acceptable drawdown."]',
  '["strategy_spec:data/strategy_specs/smrc_vwap_reclaim_v1_candidate.json","calibration:data/strategy_calibrations/smrc_vwap_reclaim_v1_threshold_selection_20260707.json","finlab_runner:tools/finlab_strategy_spec_backtest.py","registry_seed:20260707"]',
  'p5_strategy_governance',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(strategy_id, version) DO UPDATE SET
  name=excluded.name,
  status=excluded.status,
  owner=excluded.owner,
  alpha_bucket=excluded.alpha_bucket,
  family_id=excluded.family_id,
  variant_id=excluded.variant_id,
  owner_type=excluded.owner_type,
  promotion_status=excluded.promotion_status,
  supported_regimes_json=excluded.supported_regimes_json,
  thesis=excluded.thesis,
  thresholds_json=excluded.thresholds_json,
  candidate_policy_json=excluded.candidate_policy_json,
  risk_notes_json=excluded.risk_notes_json,
  source_refs_json=excluded.source_refs_json,
  created_by=excluded.created_by,
  updated_at=CURRENT_TIMESTAMP;
