-- Learning-domain mirror of legacy migration 0110.
ALTER TABLE strategy_decision_log
  ADD COLUMN evaluability_status TEXT NOT NULL DEFAULT 'UNKNOWN_LEGACY'
  CHECK(evaluability_status IN (
    'EVALUABLE','NOT_APPLICABLE_PHASE','NOT_APPLICABLE_OWNER','PENDING_AVAILABILITY',
    'MISSING_SOURCE','STALE_SOURCE','SOURCE_ERROR','INVALID_SPEC','PIT_VIOLATION','UNKNOWN_LEGACY'
  ));

ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN evaluability_status TEXT NOT NULL DEFAULT 'UNKNOWN_LEGACY'
  CHECK(evaluability_status IN (
    'EVALUABLE','NOT_APPLICABLE_PHASE','NOT_APPLICABLE_OWNER','PENDING_AVAILABILITY',
    'MISSING_SOURCE','STALE_SOURCE','SOURCE_ERROR','INVALID_SPEC','PIT_VIOLATION','UNKNOWN_LEGACY'
  ));
UPDATE strategy_decision_log
   SET evaluability_status=CASE
     WHEN evaluable=1 THEN 'EVALUABLE'
     WHEN unavailable_reason IS NULL OR trim(unavailable_reason)='' THEN 'UNKNOWN_LEGACY'
     WHEN lower(unavailable_reason) LIKE '%pit%' OR lower(unavailable_reason) LIKE '%lookahead%' THEN 'PIT_VIOLATION'
     WHEN lower(unavailable_reason) LIKE '%stale%' OR lower(unavailable_reason) LIKE '%expired%' THEN 'STALE_SOURCE'
     WHEN lower(unavailable_reason) LIKE '%source_error%' OR lower(unavailable_reason) LIKE '%provider_error%' THEN 'SOURCE_ERROR'
     ELSE 'MISSING_SOURCE'
   END;

UPDATE strategy_label_matrix_v4
   SET evaluability_status=CASE
     WHEN evaluable=1 THEN 'EVALUABLE'
     WHEN unavailable_reason IS NULL OR trim(unavailable_reason)='' THEN 'UNKNOWN_LEGACY'
     WHEN lower(unavailable_reason) LIKE '%pit%' OR lower(unavailable_reason) LIKE '%lookahead%' THEN 'PIT_VIOLATION'
     WHEN lower(unavailable_reason) LIKE '%stale%' OR lower(unavailable_reason) LIKE '%expired%' THEN 'STALE_SOURCE'
     WHEN lower(unavailable_reason) LIKE '%source_error%' OR lower(unavailable_reason) LIKE '%provider_error%' THEN 'SOURCE_ERROR'
     ELSE 'MISSING_SOURCE'
   END;


UPDATE strategy_decision_log
   SET evaluability_status='NOT_APPLICABLE_OWNER',
       evaluable=0,
       unavailable_reason='selection_phase_owned_by_s12_execution_replay'
 WHERE strategy_id='stock_tech_s12_multitimeframe_smc_reclaim_v2';

UPDATE strategy_label_matrix_v4
   SET evaluability_status='NOT_APPLICABLE_OWNER',
       evaluable=0,
       unavailable_reason='selection_phase_owned_by_s12_execution_replay'
 WHERE strategy_id='stock_tech_s12_multitimeframe_smc_reclaim_v2';

CREATE INDEX IF NOT EXISTS idx_strategy_decision_evaluability_status
  ON strategy_decision_log(date, strategy_id, evaluability_status, matched);

CREATE INDEX IF NOT EXISTS idx_strategy_matrix_evaluability_status
  ON strategy_label_matrix_v4(signal_date, strategy_id, evaluability_status, strategy_hit);
