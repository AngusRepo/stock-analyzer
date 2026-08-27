ALTER TABLE strategy_route_backfill_eligibility_v1 ADD COLUMN route_version TEXT;
ALTER TABLE strategy_route_backfill_eligibility_v1 ADD COLUMN affinity_version TEXT;

UPDATE strategy_route_backfill_eligibility_v1 AS eligibility
   SET route_version='strategy-semantic-continuous-affinity-v5',
       affinity_version='strategy-threshold-margin-affinity-v2'
 WHERE eligibility.reference_rows > 0
   AND eligibility.reference_rows=(
     SELECT COUNT(*)
       FROM selection_reference_snapshots_v1 AS reference
      WHERE reference.signal_date=eligibility.signal_date
        AND reference.producer_run_id=eligibility.producer_run_id
        AND reference.hard_gate_passed=1
        AND reference.strategy_challenger_route_version='strategy-semantic-continuous-affinity-v5'
        AND reference.strategy_challenger_affinity_version='strategy-threshold-margin-affinity-v2'
        AND reference.strategy_challenger_route_score IS NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_strategy_route_backfill_eligibility_v1_semantic
  ON strategy_route_backfill_eligibility_v1(
    route_version,
    affinity_version,
    status,
    signal_date
  );
