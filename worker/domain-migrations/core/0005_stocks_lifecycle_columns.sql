-- Keep the split Core D1 stocks registry aligned with production lifecycle metadata.
ALTER TABLE stocks ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE stocks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stocks ADD COLUMN listed_date TEXT;
ALTER TABLE stocks ADD COLUMN delisted_date TEXT;
ALTER TABLE stocks ADD COLUMN delist_reason TEXT;
