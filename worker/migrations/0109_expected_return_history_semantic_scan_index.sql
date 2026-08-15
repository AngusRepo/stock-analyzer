-- Supports bounded keyset pagination for the two-owner expected-return
-- history semantic guard.  event_id is the deterministic tie-breaker used by
-- both interval adjacency and the resumable cursor.
CREATE INDEX IF NOT EXISTS idx_model_champion_history_semantic_scan
  ON model_champion_history(model_name, effective_at, event_id);
