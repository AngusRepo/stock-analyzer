import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  evaluateStrategyRouteCalibration,
  type StrategyRouteObservation,
} from './strategyRouteCalibration'

function date(index: number): string {
  return '2026-06-' + String(index + 1).padStart(2, '0')
}

const informative: StrategyRouteObservation[] = []
for (let day = 0; day < 20; day += 1) {
  for (let symbol = 0; symbol < 20; symbol += 1) {
    const high = symbol >= 14
    informative.push({
      signal_date: date(day),
      symbol: String(1000 + symbol),
      route_score: high ? 80 + symbol / 10 : 10 + symbol,
      incumbent_route_score: 100 - symbol,
      absolute_return_net: high ? 0.025 + day * 0.0001 : -0.01,
      residual_return_net: high ? 0.02 + day * 0.0001 : -0.008,
    })
  }
}
const pass = evaluateStrategyRouteCalibration(informative)
assert.equal(pass.status, 'pass', 'stable cost-net OOS edge should pass route calibration')
assert((pass.routeFloor ?? 0) > 0, 'route floor must be learned from train dates')
assert((pass.topBucketNetReturnLcb90 ?? 0) > 0, 'top bucket OOS net-return LCB must be positive')
assert((pass.absoluteSpreadLcb90 ?? 0) > 0, 'challenger directionality LCB must be positive')
assert((pass.residualSpreadLcb90 ?? 0) > 0, 'OOS residual spread LCB must be positive')
assert((pass.challengerIncumbentDeltaLcb90 ?? 0) > 0, 'challenger continuous weights must beat incumbent continuous weights')
assert.equal(pass.gates.incumbent_route_lineage_complete, true, 'paired incumbent lineage must be complete')
assert(pass.trainDates.at(-1)! < pass.oosDates[0], 'OOF split must be chronological')
assert.equal(pass.purgeDates.length, 5, 'five signal dates must be purged between train and OOS')

const tenDateBoundary = evaluateStrategyRouteCalibration(
  informative.filter((row) => row.signal_date <= date(9)),
)
assert.equal(tenDateBoundary.status, 'pending_maturity', 'three train, five purge, and three OOS dates require 11 mature dates')
assert.equal(tenDateBoundary.gates.enough_total_dates, false, '10 mature dates must not be reported as calibration-ready')

const noEdge = informative.map((row, index) => ({
  ...row,
  absolute_return_net: index % 2 ? 0.01 : -0.01,
  residual_return_net: index % 2 ? -0.005 : 0.005,
}))
assert.equal(evaluateStrategyRouteCalibration(noEdge).status, 'fail', 'non-informative route score must fail closed')

const source = readFileSync(new URL('./strategyRouteCalibration.ts', import.meta.url), 'utf8')
assert(source.includes('l.outcome_known_date <= ?'), 'calibration loader must enforce outcome-known PIT cutoff')
assert(source.includes('canonicalRunIds?: Record<string, string>'), 'calibration loader must accept cross-D1 canonical authority')
assert(source.includes('FROM json_each(?)'), 'calibration loader must use the canonical run-id map after Learning D1 cutover')
assert(source.includes('const PURGE_DATES = 5'), 'calibration must purge overlapping five-session target windows')
assert(source.includes('no_top_k: true'), 'artifact evidence must state that no top-k admission or comparison is used')
assert(source.includes('continuousRouteWeight'), 'incumbent comparison must use full-universe continuous positive weights')
assert(!source.includes('incumbentTopK'), 'calibration must not use a rank-based top-k incumbent comparator')
assert(source.includes("r.status='promoted'"), 'serving loader must only accept promoted artifacts')

console.log('strategyRouteCalibration tests passed')
