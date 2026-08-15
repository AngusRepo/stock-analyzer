-- Keep Learning D1 query shape equivalent to legacy DB for bounded pointer
-- history semantic validation.
CREATE INDEX IF NOT EXISTS idx_model_champion_history_semantic_scan
  ON model_champion_history(model_name, effective_at, event_id);
