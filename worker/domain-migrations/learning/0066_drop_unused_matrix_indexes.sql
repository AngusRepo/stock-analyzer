-- M2 strategy_label_matrix_v4 indexes 8 -> 5 (PK, _evaluable, _challenger_v2, _symbol, _profile_evidence).
-- EXPLAIN QUERY PLAN over every matrix statement on the learning domain schema, in 20 index creation
-- orders (prod has no sqlite_stat1): idx_strategy_matrix_evaluability_status is never chosen;
-- _regime_veto and _challenger_v1 are chosen only as ties for signal_date=? lookups (no statement
-- filters on their trailing columns) and those plans move to _evaluable with the same lookup and the
-- same COVERING flag. Locked by src/lib/learningMatrixDecisionIndexPlans.test.ts.
-- Rollback: re-create from 0001_learning_baseline.sql / 0008.
DROP INDEX IF EXISTS idx_strategy_label_matrix_v4_regime_veto;
DROP INDEX IF EXISTS idx_strategy_label_matrix_challenger_v1;
DROP INDEX IF EXISTS idx_strategy_matrix_evaluability_status;
