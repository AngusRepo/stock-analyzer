CREATE INDEX IF NOT EXISTS idx_broker_events_intent_retention ON broker_execution_events(intent_id);
CREATE INDEX IF NOT EXISTS idx_broker_events_leg_retention ON broker_execution_events(leg_id);

CREATE INDEX IF NOT EXISTS idx_execution_retention_release_lookup
ON execution_retention_releases_v1(dataset_id,released_at,artifact_id);
