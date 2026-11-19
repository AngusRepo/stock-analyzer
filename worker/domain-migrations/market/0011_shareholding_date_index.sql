-- dataset snapshot export (ml-controller dataset_snapshot_exporter._query_shareholding) reads one
-- date range per export chunk. shareholding only had (stock_id, date) indexes, so each chunk
-- scanned the table (~1,281 scans per export on 2026-11-18). The query seeks its two raw ranges
-- (YYYY-MM-DD and TDCC YYYYMMDD) through this index and keeps replace() as the exact filter.
-- Size: 10,851 rows on 2026-11-18 x ~16 B (8-10 B date + rowid + header) = ~0.2 MB; weekly TDCC
-- rows for ~2,400 listed issuers add ~2 MB a year (~20 MB over ten years, before retention).
-- Not applied by this change: apply with the normal market migration flow after review.
-- Rollback: DROP INDEX IF EXISTS idx_shareholding_date;
CREATE INDEX IF NOT EXISTS idx_shareholding_date ON shareholding(date);
