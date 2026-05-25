-- Compute profile wait attribution columns.
-- Run only after Wei approval, and only once per D1 database if the columns are absent:
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_compute_profile_events_wait_columns.sql

ALTER TABLE compute_profile_events ADD COLUMN await_sec REAL;
ALTER TABLE compute_profile_events ADD COLUMN compute_owner TEXT;
ALTER TABLE compute_profile_events ADD COLUMN remote_function TEXT;
