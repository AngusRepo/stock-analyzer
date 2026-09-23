-- Paper-stage authority is independent of statistical NAV adoption.
-- Existing active strategy weights stay unchanged; V7 can no longer publish replacements.
SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM strategy_route_calibration_head_v1
   WHERE singleton_id=1 AND artifact_version<>'strategy-route-nav-adoption-v1')
THEN 1 ELSE json('legacy_route_head_requires_review') END;
CREATE TABLE IF NOT EXISTS strategy_replacement_authority_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
  owner TEXT NOT NULL CHECK (owner='original_paired_daily_nav'),
  effective_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
  reason TEXT NOT NULL CHECK (reason='paper_nav_governance_cutover')
);
INSERT OR IGNORE INTO strategy_replacement_authority_v1 (singleton_id,owner,reason)
VALUES (1,'original_paired_daily_nav','paper_nav_governance_cutover');
CREATE TRIGGER IF NOT EXISTS strategy_replacement_authority_no_update_v1
BEFORE UPDATE ON strategy_replacement_authority_v1
BEGIN SELECT RAISE(ABORT,'strategy_replacement_authority_immutable'); END;
CREATE TRIGGER IF NOT EXISTS strategy_replacement_authority_no_delete_v1
BEFORE DELETE ON strategy_replacement_authority_v1
BEGIN SELECT RAISE(ABORT,'strategy_replacement_authority_immutable'); END;
CREATE TRIGGER IF NOT EXISTS strategy_route_nav_only_head_insert_v1
BEFORE INSERT ON strategy_route_calibration_head_v1
WHEN EXISTS(SELECT 1 FROM strategy_replacement_authority_v1 WHERE singleton_id=1)
  AND NEW.artifact_version<>'strategy-route-nav-adoption-v1'
BEGIN SELECT RAISE(ABORT,'strategy_route_nav_only_publication'); END;
CREATE TRIGGER IF NOT EXISTS strategy_route_nav_only_head_update_v1
BEFORE UPDATE ON strategy_route_calibration_head_v1
WHEN EXISTS(SELECT 1 FROM strategy_replacement_authority_v1 WHERE singleton_id=1)
  AND NEW.artifact_version<>'strategy-route-nav-adoption-v1'
BEGIN SELECT RAISE(ABORT,'strategy_route_nav_only_publication'); END;
CREATE TRIGGER IF NOT EXISTS strategy_marginal_edge_nav_only_head_insert_v1
BEFORE INSERT ON strategy_marginal_edge_head_v4
WHEN NEW.owner_key='production'
  AND EXISTS(SELECT 1 FROM strategy_replacement_authority_v1 WHERE singleton_id=1)
BEGIN SELECT RAISE(ABORT,'strategy_marginal_edge_nav_only_publication'); END;
CREATE TRIGGER IF NOT EXISTS strategy_marginal_edge_nav_only_head_update_v1
BEFORE UPDATE ON strategy_marginal_edge_head_v4
WHEN NEW.owner_key='production'
  AND EXISTS(SELECT 1 FROM strategy_replacement_authority_v1 WHERE singleton_id=1)
BEGIN SELECT RAISE(ABORT,'strategy_marginal_edge_nav_only_publication'); END;
