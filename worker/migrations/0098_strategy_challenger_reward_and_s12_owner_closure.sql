-- Keep incumbent affinity lineage separate from the threshold-margin challenger.
ALTER TABLE strategy_label_matrix_v4
  ADD COLUMN challenger_affinity_version TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_challenger_v2
  ON strategy_label_matrix_v4(
    signal_date,
    challenger_affinity_version,
    strategy_id,
    evaluable,
    challenger_affinity
  );

-- Legal PIT repair: copy only the challenger version emitted by the same
-- canonical producer run. No future label, return, or later artifact is used.
UPDATE strategy_label_matrix_v4 AS matrix
   SET challenger_affinity_version = (
     SELECT reference.strategy_challenger_affinity_version
       FROM selection_reference_snapshots_v1 AS reference
      WHERE reference.signal_date = matrix.signal_date
        AND reference.symbol = matrix.symbol
        AND reference.producer_run_id = matrix.producer_run_id
      LIMIT 1
   )
 WHERE matrix.signal_date BETWEEN '2026-07-29' AND '2026-07-31'
   AND matrix.challenger_affinity_version IS NULL
   AND EXISTS (
     SELECT 1
       FROM selection_reference_snapshots_v1 AS reference
      WHERE reference.signal_date = matrix.signal_date
        AND reference.symbol = matrix.symbol
        AND reference.producer_run_id = matrix.producer_run_id
        AND reference.strategy_challenger_affinity_version = 'strategy-threshold-margin-affinity-v2'
   );

-- V2 is the sole formal S12 strategy-learning owner. V1 remains queryable in
-- historical lineage but must not appear as a second live learning strategy.
UPDATE strategy_spec_registry
   SET status = 'retired',
       owner = 'retired',
       owner_type = 'retired',
       promotion_status = 'retired',
       thesis = 'Superseded by stock_tech_s12_multitimeframe_smc_reclaim_v2; retained only for historical lineage.',
       updated_at = CURRENT_TIMESTAMP
 WHERE strategy_id = 'stock_tech_s12_multitimeframe_smc_reclaim_v1';
