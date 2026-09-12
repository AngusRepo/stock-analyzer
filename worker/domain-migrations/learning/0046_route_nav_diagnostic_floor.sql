-- NAV adopts the executable route, not a fitted diagnostic cutoff.
-- Preserve the one existing route head and all prior publication timestamps.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE strategy_route_calibration_head_nav_migration (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  run_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  candidate_route_version TEXT NOT NULL,
  route_floor REAL,
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(route_floor IS NOT NULL OR artifact_version='strategy-route-nav-adoption-v1'),
  FOREIGN KEY(run_id) REFERENCES strategy_route_calibration_runs_v1(run_id)
);
INSERT INTO strategy_route_calibration_head_nav_migration
SELECT singleton_id,run_id,artifact_version,candidate_route_version,route_floor,promoted_at
FROM strategy_route_calibration_head_v1;
DROP TABLE strategy_route_calibration_head_v1;
ALTER TABLE strategy_route_calibration_head_nav_migration RENAME TO strategy_route_calibration_head_v1;
