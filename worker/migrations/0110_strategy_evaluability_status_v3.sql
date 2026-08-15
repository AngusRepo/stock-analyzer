-- Separate true data unavailability from owner/phase not-applicability.
ALTER TABLE strategy_decision_log
  ADD COLUMN evaluability_status TEXT;

ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN evaluability_status TEXT;
-- Legacy DB is near the 10 GB hard limit. NOT NULL/DEFAULT/CHECK additions
-- force D1 to rewrite these large tables and exceed the storage-operation
-- timeout, so the compatibility columns must remain nullable metadata-only.
-- New v3 writes always persist a canonical status. Historical NULL rows are
-- repaired by the bounded, PIT-authoritative strategy evidence reconstruction
-- flow; strict Learning routing remains fail-closed meanwhile.
