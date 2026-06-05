ALTER TABLE strategy_spec_registry ADD COLUMN family_id TEXT NOT NULL DEFAULT 'TREND_RECLAIM_CONTINUATION';
ALTER TABLE strategy_spec_registry ADD COLUMN variant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE strategy_spec_registry ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'strategy';
ALTER TABLE strategy_spec_registry ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'production';

CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_family
  ON strategy_spec_registry(family_id, status);
