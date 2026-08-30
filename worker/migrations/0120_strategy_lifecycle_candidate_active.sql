-- Canonical live strategy lifecycle: candidate -> active.
-- `shadow` remains a zero-production-effect evidence/run mode, not a strategy stage.
-- `research` remains a role/owner concern, not a strategy stage.
-- Retired rows remain immutable historical records.

UPDATE strategy_spec_registry
   SET status = 'candidate',
       promotion_status = 'candidate',
       updated_at = CURRENT_TIMESTAMP
 WHERE status IN ('shadow', 'research')
   AND promotion_status <> 'retired';

ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN pre_regime_setup_hit INTEGER NOT NULL DEFAULT 0 CHECK(pre_regime_setup_hit IN (0, 1));
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN regime_eligible INTEGER NOT NULL DEFAULT 1 CHECK(regime_eligible IN (0, 1));
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN formal_veto_reason TEXT;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN counterfactual_affinity REAL NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN counterfactual_production_effect INTEGER NOT NULL DEFAULT 0 CHECK(counterfactual_production_effect = 0);

CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_regime_veto
  ON strategy_label_matrix_v4(signal_date, strategy_id, pre_regime_setup_hit, regime_eligible);
