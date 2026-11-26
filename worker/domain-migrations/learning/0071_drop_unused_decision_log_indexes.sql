-- D1-M2 follow-up (NEW-D05/D06): strategy_decision_log 8 -> 4 full indexes.
-- The 2026-11-12 EXPLAIN sweep of every statement on the table (audits/matrix-split-plan-20261112)
-- found these four unused, and a 2026-11-24 re-sweep of all 53 prod learning-db queries that touch
-- the table (31-day insights, top 500 by count and by rows read) gives 0 plan changes with them gone.
-- Kept: _date (date DESC, strategy_id, matched) for every date range/equality, _context,
-- the two audit-json pending partial indexes (0069) and the two UNIQUE autoindexes.
-- Runtime DDL: no live Worker/controller re-creates them since 8a1efea3 (in live 2fc5c4b0);
-- strategyLearning.ts bootstraps only _date. Locked by learningMatrixDecisionIndexPlans.test.ts.
-- Size (estimate, not measured: D1 exposes no dbstat): ~1.7M rows x ~190 B of index entries
-- (symbol+date, status+matched+date, date+strategy_id+evaluable+matched,
-- date+strategy_id+evaluability_status+matched, each + rowid) = ~0.3-0.4 GB, ~4 MB per trading day.
-- Rollback (each rebuild reads the table once):
--   CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_symbol ON strategy_decision_log(symbol, date DESC);
--   CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_status ON strategy_decision_log(strategy_status, matched, date DESC);
--   CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_evaluability ON strategy_decision_log(date DESC, strategy_id, evaluable, matched);
--   CREATE INDEX IF NOT EXISTS idx_strategy_decision_evaluability_status ON strategy_decision_log(date, strategy_id, evaluability_status, matched);
DROP INDEX IF EXISTS idx_strategy_decision_log_symbol;
DROP INDEX IF EXISTS idx_strategy_decision_log_status;
DROP INDEX IF EXISTS idx_strategy_decision_log_evaluability;
DROP INDEX IF EXISTS idx_strategy_decision_evaluability_status;
