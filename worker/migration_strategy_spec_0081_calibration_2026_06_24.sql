-- 0081 formal137 feature-ref calibration / revalidation repair.
-- Root cause: original weightedScore.min=0.62 was calibrated on a different
-- score scale; 2026-06-22 validation had 820/820 complete feature refs but
-- 0 matches at 0.62. The validation-fold top-after-base-gates cutoff for the
-- strategy poolQuota=16 is 0.382732, with 11 holdout matches on 2026-06-23.

UPDATE strategy_spec_registry
SET
  thresholds_json = json_set(
    thresholds_json,
    '$.featureRefs.weightedScore.calibration',
    json('{"schemaVersion":"strategy-feature-ref-weighted-score-calibration-v1","calibrationId":"alpha_miner_pymoo_nsga3_novelty_0081:formal137-scale:v20260622","status":"active","method":"validation_fold_top_after_base_gates","originalMin":0.62,"calibratedMin":0.382732,"validationFold":{"startDate":"2026-06-22","endDate":"2026-06-22","excludedDates":["2026-06-23"]},"targetDailyMatches":16,"observed":{"validationRows":820,"validationCompleteFeatureRows":820,"validationMatchesAtOriginalMin":0,"validationMatchesAtCalibratedMin":16,"holdoutDate":"2026-06-23","holdoutMatchesAtCalibratedMin":11},"sourceRefs":["strategy_decision_log:2026-06-22","strategy_decision_log:2026-06-23","strategy_spec_registry:alpha_miner_pymoo_nsga3_novelty_0081:strategy-spec-v1"],"frozenAt":"2026-06-24T00:00:00Z"}')
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE strategy_id = 'alpha_miner_pymoo_nsga3_novelty_0081'
  AND version = 'strategy-spec-v1'
  AND status = 'active'
  AND promotion_status = 'production'
  AND json_extract(thresholds_json, '$.featureRefs.weightedScore.min') = 0.62;
