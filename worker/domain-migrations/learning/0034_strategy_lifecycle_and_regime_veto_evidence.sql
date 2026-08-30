-- Live strategy lifecycle is Candidate -> Active. Shadow remains an evidence/run
-- mode with zero production effect; it is not a strategy registry stage.
UPDATE strategy_spec_registry
   SET status = 'candidate',
       promotion_status = 'candidate',
       updated_at = CURRENT_TIMESTAMP
 WHERE status IN ('shadow', 'research')
   AND promotion_status <> 'retired';

-- Preserve setup evidence before the formal supported-regime veto. Historical
-- rows remain conservative defaults and are never reconstructed from future data.
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN pre_regime_setup_hit INTEGER NOT NULL DEFAULT 0 CHECK(pre_regime_setup_hit IN (0, 1));
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN regime_eligible INTEGER NOT NULL DEFAULT 1 CHECK(regime_eligible IN (0, 1));
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN formal_veto_reason TEXT;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN counterfactual_affinity REAL NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN counterfactual_production_effect INTEGER NOT NULL DEFAULT 0 CHECK(counterfactual_production_effect = 0);

ALTER TABLE strategy_label_matrix_staging_v4
  ADD COLUMN pre_regime_setup_hit INTEGER NOT NULL DEFAULT 0 CHECK(pre_regime_setup_hit IN (0, 1));
ALTER TABLE strategy_label_matrix_staging_v4
  ADD COLUMN regime_eligible INTEGER NOT NULL DEFAULT 1 CHECK(regime_eligible IN (0, 1));
ALTER TABLE strategy_label_matrix_staging_v4 ADD COLUMN formal_veto_reason TEXT;
ALTER TABLE strategy_label_matrix_staging_v4 ADD COLUMN counterfactual_affinity REAL NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_staging_v4
  ADD COLUMN counterfactual_production_effect INTEGER NOT NULL DEFAULT 0 CHECK(counterfactual_production_effect = 0);

CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_regime_veto
  ON strategy_label_matrix_v4(signal_date, strategy_id, pre_regime_setup_hit, regime_eligible);
