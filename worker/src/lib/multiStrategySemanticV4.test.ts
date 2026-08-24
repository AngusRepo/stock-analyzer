import assert from 'node:assert/strict'
import {
  STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION,
  buildMultiStrategyPleRoutingPlan,
} from './multiStrategyPleRouter'
import type { StrategyCandidatePoolCandidate } from './strategyCandidatePool'
import type { StrategySpec } from './strategySpec'

const spec: StrategySpec = {
  id: 'alpha223_0009',
  version: 'strategy-spec-v1',
  name: 'paired semantic route',
  status: 'active',
  owner: 'strategy',
  familyId: 'ALPHA223_CASH_GAP_BROKER_FLOW',
  variantId: 'alpha223_0009_cash_gap_broker_flow_v1',
  ownerType: 'strategy',
  promotionStatus: 'production',
  alphaBucket: 'breakout_vol_expansion',
  supportedRegimes: ['bull', 'sideways', 'volatile'],
  thesis: 'paired semantic route test',
  thresholds: {
    featureRefs: {
      weightedScore: {
        min: 0.5,
        terms: [{ featureRef: 'tech_gap_down', signal: 'factorSignals.techGapDown', weight: 1 }],
      },
    },
  },
  candidatePolicy: { poolQuota: 10, costBudget: 10, evidenceRequirements: [], maxMlShare: 1 },
  riskNotes: [],
  createdBy: 'p5_strategy_governance',
}

const candidates: StrategyCandidatePoolCandidate[] = [
  {
    symbol: '1111',
    eligible_for_ml: true,
    raw_signals: { factorSignals: { techGapDown: 0.9, finlabCsV2TechGapDownNoGapRank: 0.1 } },
  },
  {
    symbol: '2222',
    eligible_for_ml: true,
    raw_signals: { factorSignals: { techGapDown: 0.1, finlabCsV2TechGapDownNoGapRank: 0.9 } },
  },
]

const incumbent = buildMultiStrategyPleRoutingPlan(candidates, [spec], {
  maxSlateSize: candidates.length,
  evidenceMode: 'historical_replay',
})
assert.deepEqual(incumbent.mlSlate.map((row) => row.symbol), ['1111'])
assert.equal(incumbent.l0Annotated.find((row) => row.symbol === '2222')?.strategy_challenger_hit_vector?.[spec.id], 1)

const promoted = buildMultiStrategyPleRoutingPlan(candidates, [spec], {
  maxSlateSize: candidates.length,
  evidenceMode: 'historical_replay',
  promotedRouteCalibration: {
    runId: 'paired-v4-pass',
    routeVersion: STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION,
    routeFloor: 0,
  },
})
assert.deepEqual(promoted.mlSlate.map((row) => row.symbol), ['2222'])
assert.equal(promoted.telemetry.route_gate_authority, 'continuous_weight_promoted')
assert.equal(promoted.telemetry.route_veto_applied, false)
assert.equal(promoted.l0Annotated.length, candidates.length)
assert.equal(promoted.mlSlate[0].strategy_position_weight_vector?.[spec.id], 1)

console.log('multi-strategy semantic v4 tests passed')
