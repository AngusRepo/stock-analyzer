-- Persist canonical Score V2 payload for L2 decision attribution and weekly audit.
ALTER TABLE decision_logs ADD COLUMN score_components TEXT;
