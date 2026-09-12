/** Compare the ORIGINAL executable Route dependency, not another NAV gate. */
import { loadPromotedStrategyRouteCalibration } from './strategyRouteCalibration'
import { atomicNavCanonical, atomicNavDigest } from './strategyAtomicNavReceipt'

type Row = Record<string, any>
type Route = Awaited<ReturnType<typeof loadPromotedStrategyRouteCalibration>>
const rowGuard = (db: D1Database, table: 'strategy_route_calibration_head_v1' | 'strategy_route_calibration_runs_v1', row: Row) => {
  const keys = Object.keys(row)
  return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table}
    WHERE ${keys.map(key => `${key} IS ?`).join(' AND ')})
    THEN 1 ELSE json('nav_route_dependency_changed') END`).bind(...keys.map(key => row[key]))
}

export async function readNavRouteDependency(db: D1Database, expected: Route | undefined) {
  const head = await db.prepare('SELECT * FROM strategy_route_calibration_head_v1 WHERE singleton_id=1').first<Row>()
  const run = head ? await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1 WHERE run_id=?').bind(head.run_id).first<Row>() : null
  if (head && (!run || run.status !== 'promoted' || head.artifact_version !== run.artifact_version
    || head.candidate_route_version !== run.candidate_route_version || head.route_floor !== run.route_floor))
    throw new Error('nav_route_dependency_head_invalid')
  const serving = await loadPromotedStrategyRouteCalibration(db)
  // runId is lineage, not an input to the routing score/floor. Do not create
  // another qualification condition merely because an equal policy was logged.
  const semantic = (route: Route | undefined) => route == null ? null
    : { routeVersion: route.routeVersion, routeFloor: route.routeFloor }
  return { serving, matches: atomicNavCanonical(semantic(serving)) === atomicNavCanonical(semantic(expected)),
    checksum: await atomicNavDigest({ head, run }), statements: head && run
      ? [rowGuard(db, 'strategy_route_calibration_head_v1', head), rowGuard(db, 'strategy_route_calibration_runs_v1', run)]
      : [db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM strategy_route_calibration_head_v1 WHERE singleton_id=1)
          THEN 1 ELSE json('nav_route_dependency_changed') END`)] }
}
