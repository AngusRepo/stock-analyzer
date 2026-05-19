-- V4.3 D1 cost indexes.
-- Scope: indexes backed by observed production EXPLAIN plans and hot V4
-- canonical / maintenance query paths. Keep this targeted to avoid write
-- amplification on ingestion-heavy tables.

-- FinLab canonical daily tables are read date-first by screener, regime,
-- sector flow, and data-quality jobs. The primary keys are stock-first, so
-- date-window scans otherwise walk the full autoindex.
CREATE INDEX IF NOT EXISTS idx_canonical_market_date_stock
  ON canonical_market_daily(date DESC, stock_id);

CREATE INDEX IF NOT EXISTS idx_canonical_chip_date_segment_stock
  ON canonical_chip_daily(date DESC, market_segment, stock_id);

-- Backfill/diff health checks and future cold-window retention read revenue
-- month-first. The canonical primary key is stock-first.
CREATE INDEX IF NOT EXISTS idx_canonical_revenue_month_stock
  ON canonical_revenue_monthly(revenue_month DESC, stock_id);

-- Margin data is stock-first for detail pages, but dataset snapshots,
-- retention planning, and global freshness checks are date-window scans.
CREATE INDEX IF NOT EXISTS idx_margin_data_date_stock
  ON margin_data(date, stock_id);

-- News detail pages are stock-first; buzz and cleanup paths are time-first.
CREATE INDEX IF NOT EXISTS idx_news_published_id
  ON news(published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_news_created_id
  ON news(created_at DESC, id DESC);
