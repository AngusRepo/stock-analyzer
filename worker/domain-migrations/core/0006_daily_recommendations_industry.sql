-- Preserve the production daily recommendation industry context in split Core D1.
ALTER TABLE daily_recommendations ADD COLUMN industry TEXT;
