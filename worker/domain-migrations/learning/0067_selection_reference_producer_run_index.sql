-- persistSelectionEvidenceV4 reads a producer's earlier routing rows by producer_run_id alone, on
-- purpose without signal_date: a producer's rows on another date (legacy rows without a run header)
-- must still be found and refused (selectionEvidenceWriterCas.test.ts, foreign-date). No index led
-- with producer_run_id, so every call scanned the table (prod D1 insights, 31 days to 2026-11-13:
-- this SELECT 40,013 rows per call; the former producer-only writer DELETE 47,045 avg / 56,909
-- latest; table about 57k rows, +~860 per trading day). This index makes it a SEARCH over the
-- run's own rows, and also the daily pipeline summary's reference count (routes/other.ts).
-- +1 index write per inserted or deleted row; about 2.4-3 MB at 57k rows.
-- Locked by src/lib/selectionReferencePreviousRoutingSeek.test.ts.
-- Rollback: DROP INDEX IF EXISTS idx_selection_reference_v1_producer_run;
CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_producer_run
  ON selection_reference_snapshots_v1(producer_run_id);
