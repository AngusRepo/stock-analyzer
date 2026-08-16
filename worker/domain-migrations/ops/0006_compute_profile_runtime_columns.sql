-- Match the authoritative production compute_profile_events schema. These
-- columns were added after the original table migration and are required for
-- exact shadow-copy schema parity.
ALTER TABLE compute_profile_events ADD COLUMN await_sec REAL;
ALTER TABLE compute_profile_events ADD COLUMN compute_owner TEXT;
ALTER TABLE compute_profile_events ADD COLUMN remote_function TEXT;
