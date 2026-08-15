-- Separate true data unavailability from owner/phase not-applicability.
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
-- Legacy DB is near the 10 GB hard limit. Do not rewrite the 800k+ historical
-- rows or build large compatibility indexes inside a migration transaction.
-- New v3 writes always persist an explicit status. Historical UNKNOWN_LEGACY
-- rows are repaired by the bounded, PIT-authoritative strategy evidence
-- reconstruction flow; strict Learning routing remains fail-closed meanwhile.
