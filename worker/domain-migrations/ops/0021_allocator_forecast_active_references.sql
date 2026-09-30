-- New allocator forecast owner only. No source rows or retention settings change.
CREATE INDEX IF NOT EXISTS idx_allocator_forecast_active_refs_v1
  ON artifact_hard_references(owner_id, artifact_id)
  WHERE owner_type='allocator_ev_forecast_run' AND active=1;
