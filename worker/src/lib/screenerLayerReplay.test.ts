import {
  buildScreenerLayerReplayReport,
  type ScreenerLayerReplayCandidate,
} from './screenerLayerReplay'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function candidate(
  symbol: string,
  source: ScreenerLayerReplayCandidate['source'],
  rank: number,
  ret5: number,
): ScreenerLayerReplayCandidate {
  return {
    runId: 'run-1',
    date: '2026-06-01',
    symbol,
    source,
    score: 100 - rank,
    rank,
    ret1: ret5 / 5,
    ret5,
    ret20: ret5 * 2,
  }
}

const report = buildScreenerLayerReplayReport([
  candidate('2330', 'strategy_hit', 1, 0.03),
  candidate('2885', 'raw_top_up_observe', 2, -0.02),
  candidate('2303', 'raw_top_up_observe', 3, -0.03),
  candidate('2454', 'strategy_hit', 4, 0.02),
  candidate('3711', 'strategy_hit', 5, 0.01),
  candidate('2603', 'strategy_hit', 6, 0),
], {
  startDate: '2026-06-01',
  endDate: '2026-06-01',
  l2KeepRatio: 0.75,
  l3KeepRatio: 0.7,
})

const strategyOnly = report.scenarios.find((scenario) => scenario.scenarioId === 'strategy_only')
const plusTopUp = report.scenarios.find((scenario) => scenario.scenarioId === 'strategy_plus_raw_top_up')

assert(report.version === 'screener_layer_replay_v1', 'replay report should expose a stable version')
assert(strategyOnly != null, 'strategy-only scenario should exist')
assert(plusTopUp != null, 'strategy + top-up scenario should exist')
assert(strategyOnly!.stages[0].count === 4, 'strategy-only L1 should exclude raw top-up observe rows')
assert(strategyOnly!.stages[1].count === 3, 'L2 keep ratio should shrink strategy-only rows')
assert(strategyOnly!.stages[2].count === 3, 'L3 keep ratio should shrink from L2 rows')
assert(plusTopUp!.stages[0].count === 6, 'top-up replay scenario should include observe rows')
assert(plusTopUp!.stages[2].rawTopUpCount > 0, 'top-up replay should expose raw top-up contamination at L3')
assert(
  (report.summary.ret5DeltaTopUpVsStrategyOnly ?? 0) < 0,
  'summary should quantify whether raw top-up hurts L3 forward return',
)
