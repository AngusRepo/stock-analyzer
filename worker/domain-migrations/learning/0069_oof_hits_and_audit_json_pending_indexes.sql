-- 1) Mature strategy OOF returns (marketScreener.buildMatureStrategyOofReturnsSql), read by the
-- nightly screener and the redundancy backfill. For as-of 2026-11-11 it read 453,696 rows in 13.4 s
-- (2026-11-14, D1 overloaded): ~2,300 canonical hit cells per mature date x 60 dates, each one a
-- random ~450 B matrix table row behind idx_strategy_label_matrix_v4_evaluable. This partial covering
-- index holds the hit cells only (evaluable=1 AND strategy_hit=1, ~11% of the matrix) with every
-- column the query needs, so each (date, strategy, canonical producer, contract, labeler) seek reads
-- only that producer's hit entries and never the table (local 22-date replica: 42,222 -> 5,105
-- distinct pages read cold). 145,793 hit cells on 2026-11-14 x ~190 B per entry (dbstat: 187 B,
-- +3 header bytes for the trailing 0/1 columns) = ~28 MB, +~2.3k entries (~0.43 MB) per trading day; it shrinks with the matrix.
-- counterfactual_production_effect is 0 in every row (CHECK), so the term drops nothing; it is there
-- so that only the OOF query, the one SQL that repeats it, can use this index. Other hit-filtered
-- matrix queries (e.g. strategyEvidenceMetrics' per-(date, symbol, producer) EXISTS) would otherwise
-- trade their primary-key seek for a covering range over every hit of the date. The three filtered
-- columns are also trailing key columns (a 0 or 1 costs one record-header byte): SQLite counts a
-- partial-index WHERE column as covered only for some predicate shapes (not this three-term one in
-- 3.54), and an uncovered column would make every hit read its table row again.
-- Locked by src/lib/matureStrategyOofReturnsSeek.test.ts.
-- Rollback: DROP INDEX IF EXISTS idx_strategy_label_matrix_v4_oof_hits;
CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_oof_hits
  ON strategy_label_matrix_v4(signal_date, strategy_id, producer_run_id, reference_contract_version, labeler_version, symbol,
    evaluable, strategy_hit, counterfactual_production_effect)
  WHERE evaluable=1 AND strategy_hit=1 AND counterfactual_production_effect=0;

-- 2) audit-json retention (auditJsonArchive.ts). Its strategy_decision_log pages and "pending"
-- probes walked every row below the cutoff and read its JSON on each run: 2026-11-13, 40 runs of
-- 12.1 s / 1.32M rows plus 40 probes of 4.1 s / 1.32M rows, and ref-v2 24 runs of 9.8 s / 1.64M rows,
-- with nothing left to archive. Each index holds exactly the rows its target still has to process,
-- keyed in page order; the WHERE clauses repeat the query predicates verbatim (SQLite uses a partial
-- index only then), and a row enters or leaves the index whenever a write changes its eligibility.
-- Archive target: rows with a >1 KB JSON column not yet archived; ~0 rows today (evidence lives in
-- artifacts), so ~0 MB. Ref-v2 target: unmarked rows with a JSON object, i.e. the 7-day hot window
-- (111,801 rows on 2026-11-14) plus any backlog: ~135 B per entry (decision_id ~116 chars), ~15-19 MB,
-- flat over time. +1 index write per decision row inserted and per ref-v2 compaction.
-- Locked by src/lib/auditJsonPendingIndex.test.ts.
-- Rollback: DROP INDEX IF EXISTS idx_strategy_decision_log_audit_json_pending;
--           DROP INDEX IF EXISTS idx_strategy_decision_log_ref_v2_pending;
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_audit_json_pending
  ON strategy_decision_log(date, decision_id)
  WHERE context_id IS NOT NULL
    AND evidence_artifact_id IS NOT NULL
    AND ((LENGTH(COALESCE(context_json, '')) > 1024
          AND COALESCE(context_json, '') NOT LIKE '%"archived_to_r2":true%')
      OR (LENGTH(COALESCE(evidence_json, '')) > 1024
          AND COALESCE(evidence_json, '') NOT LIKE '%"archived_to_r2":true%'));

CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_ref_v2_pending
  ON strategy_decision_log(date, decision_id)
  WHERE COALESCE(context_json, '') NOT LIKE '%"schema_version":"strategy-decision-json-ref-v2"%'
    AND COALESCE(evidence_json, '') NOT LIKE '%"schema_version":"strategy-decision-json-ref-v2"%'
    AND ((CASE WHEN json_valid(context_json) THEN json_type(context_json) END)='object'
      OR (CASE WHEN json_valid(evidence_json) THEN json_type(evidence_json) END)='object');
