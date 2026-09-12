-- Add provenance; never manufacture a listing date. Apply only with the
-- FinLab security-master backfill before publishing a new research snapshot.
ALTER TABLE stocks ADD COLUMN listed_date_source TEXT;
-- Exact FinLab venue. Legacy market remains TWSE/OTC/US routing family;
-- ROTC must remain distinguishable from listed TPEx securities.
ALTER TABLE stocks ADD COLUMN listing_market TEXT CHECK(listing_market IN ('TWSE','OTC','ROTC','US'));
ALTER TABLE stocks ADD COLUMN listing_observed_at TEXT;
ALTER TABLE stocks ADD COLUMN listing_checksum TEXT;
ALTER TABLE stocks ADD COLUMN listing_legacy_date TEXT;
-- The legacy migration explicitly fabricated this date for every NULL.
-- Preserve unknowns until authoritative company/ETF facts are materialized.
UPDATE stocks SET listing_legacy_date=listed_date,listed_date=NULL
WHERE listed_date='2020-01-01' AND listed_date_source IS NULL;

-- Identical capture retries are idempotent, conflicting same-clock source
-- receipts are an integrity error, not an acknowledged no-op.
CREATE TRIGGER stocks_listing_capture_conflict
BEFORE UPDATE OF listing_observed_at,listing_checksum ON stocks
WHEN OLD.listing_observed_at IS NOT NULL
 AND NEW.listing_observed_at=OLD.listing_observed_at
 AND NEW.listing_checksum IS NOT OLD.listing_checksum
BEGIN
  SELECT RAISE(ABORT,'stocks_listing_capture_conflict');
END;
