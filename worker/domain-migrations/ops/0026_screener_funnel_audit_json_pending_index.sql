-- audit-json retention (auditJsonArchive.ts), screener_funnel_items and
-- canonical_screener_funnel_items targets. Both page queries and "pending" probes walked the
-- date index below the 90-day cutoff and read every row's evidence on each run, with nothing
-- left to archive: 7 days to 2026-11-24, 714 page queries (430 of them ~0.51-0.56M rows each) and
-- 431 probes of ~0.51-0.56M rows, 478M rows read in all (ops-db's largest reader).
-- Same design as learning 0069: the index holds only rows whose evidence still has to move
-- (over 1 KB and not yet a pointer), keyed in page order; the WHERE repeats the query's archive
-- predicate verbatim (SQLite uses a partial index only then). Each target's run filter
-- (canonical heads / latest run / pitFactorFlowMap stages) is checked per index entry.
-- Size (2026-11-20 sample, 5,507 rows that day): ~3.2k entries per trading day for the 90-day
-- hot window (~200k entries, ~25 B each, ~5 MB), leaving as rows are archived. Entries that no
-- target archives stay: big pit_residual_momentum_shadow(_base) rows of canonical runs, ~135
-- per trading day (7,854 of 72,899 PIT rows on 2026-11-24 exceed 1 KB); a page below the
-- cutoff walks only those (~34k after a year) instead of every row.
-- +1 index write per inserted funnel row with >1 KB evidence and per archived row.
-- Applying it reads screener_funnel_items once (~0.65M rows) and deletes nothing.
-- Locked by src/lib/auditJsonFunnelPendingIndex.test.ts.
-- Rollback: DROP INDEX IF EXISTS idx_screener_funnel_items_audit_json_pending;
CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_audit_json_pending
  ON screener_funnel_items(date, id)
  WHERE LENGTH(COALESCE(evidence, '')) > 1024
    AND COALESCE(evidence, '') NOT LIKE '%"archived_to_r2":true%';
