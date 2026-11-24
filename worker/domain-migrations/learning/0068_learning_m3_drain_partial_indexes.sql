-- D1-M3: bounded drain candidate reads for the two datasets whose OPS gate can go active
-- (ops migration 0025, worker/src/lib/retentionLearningDrainGates.ts). Each WHERE is the
-- dataset's drain eligibility without the table prefix (test-enforced), so the hot-window drain
-- walks only drainable rows in date order and never re-reads rows that stay hot forever:
-- run-report / D1 hot-window manifests of dataset_snapshots, and every s12_structure_snapshots
-- source except the live paper writers (NEW-Q14 plan B). Index only: applying it deletes nothing.
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_m3_drainable
  ON dataset_snapshots(business_date)
  WHERE status IN ('ready','failed','expired') AND (
  (+access_tier='report' AND primary_store='r2'
    AND kind LIKE '%!_run!_report' ESCAPE '!')
  OR (+access_tier='serving' AND primary_store='d1'
    AND kind LIKE '%!_hot!_window' ESCAPE '!'));

-- (trade_date, source): covering for the drain's "anything left?" probe, which otherwise prefers the
-- covering UNIQUE(trade_date, symbol, source) index and walks every live row below the cutoff.
CREATE INDEX IF NOT EXISTS idx_s12_structure_snapshots_m3_drainable
  ON s12_structure_snapshots(trade_date, source)
  WHERE source NOT IN ('s12_intraday_structure','s12_holding_defense','s12_intraday_structure_v1');
