import assert from 'node:assert/strict'
import {
  DEFAULT_STRATEGY_SPECS,
  MONTHLY_REVENUE_EVIDENCE_SCHEMA_VERSION,
  MONTHLY_REVENUE_PIT_UNAVAILABLE_REASON,
} from './strategySpec'
import { buildLayer1StrategyBreadthPlan, type StrategyCandidatePoolCandidate } from './strategyCandidatePool'
import { assessStrategyThresholdMarginAffinity, buildMultiStrategyPleRoutingPlan } from './multiStrategyPleRouter'
import { resolveMarketScreenerEvidenceMode } from './pipelineOrchestrator'

const spec = DEFAULT_STRATEGY_SPECS.find(
  (row) => row.id === 'alphabuilders_multifactor_revenue_quality_momentum_v1',
)!
const candidate: StrategyCandidatePoolCandidate = {
  symbol: '2454',
  current_price: 120,
  score: 68,
  eligible_for_ml: true,
  raw_signals: {
    close: 120,
    closeAboveMa20Pct: 0.01,
    volumeExpansion20: 1.1,
    monthlyRevenueYoY: 12,
    monthlyRevenueMoM: 3,
    factorSignals: { monthlyRevenueYoY: 12, monthlyRevenueMoM: 3 },
    monthlyRevenueEvidence: {
      schemaVersion: MONTHLY_REVENUE_EVIDENCE_SCHEMA_VERSION,
      status: 'LIVE_CURRENT_ONLY',
      source: 'canonical_revenue_monthly',
      signalDate: '2026-08-15',
      observedTaipeiDate: '2026-08-15',
      reason: null,
    },
  },
}
const routingOptions = {
  regime: 'bull',
  strategyWeights: { [spec.id]: 1 },
} as const

const liveAssessment = assessStrategyThresholdMarginAffinity(candidate, spec, {
  ...routingOptions,
  evidenceMode: 'live_current',
})
assert.equal(liveAssessment.evaluable, true)
assert.equal(liveAssessment.matched, true)

const replayAssessment = assessStrategyThresholdMarginAffinity(candidate, spec, {
  ...routingOptions,
  evidenceMode: 'historical_replay',
})
assert.equal(replayAssessment.evaluable, false)
assert.equal(replayAssessment.matched, false)
assert.ok(replayAssessment.unavailableReasons.includes(MONTHLY_REVENUE_PIT_UNAVAILABLE_REASON))

const liveRouter = buildMultiStrategyPleRoutingPlan([candidate], [spec], {
  maxSlateSize: 1,
  ...routingOptions,
  evidenceMode: 'live_current',
})
const replayRouter = buildMultiStrategyPleRoutingPlan([candidate], [spec], {
  maxSlateSize: 1,
  ...routingOptions,
  evidenceMode: 'historical_replay',
})
assert.equal(liveRouter.l0Annotated[0].strategy_evaluable_vector?.[spec.id], 1)
assert.equal(replayRouter.l0Annotated[0].strategy_evaluable_vector?.[spec.id], 0)
assert.equal(
  replayRouter.l0Annotated[0].strategy_unavailable_reason_vector?.[spec.id],
  MONTHLY_REVENUE_PIT_UNAVAILABLE_REASON,
)

const liveBreadth = buildLayer1StrategyBreadthPlan([candidate], [spec], {
  targetSize: 1,
  coarseMlQueueSize: 1,
  ...routingOptions,
  evidenceMode: 'live_current',
})
const replayBreadth = buildLayer1StrategyBreadthPlan([candidate], [spec], {
  targetSize: 1,
  coarseMlQueueSize: 1,
  ...routingOptions,
  evidenceMode: 'historical_replay',
})
const liveBreadthCandidate = liveBreadth.l0Annotated[0] as typeof liveRouter.l0Annotated[number]
const replayBreadthCandidate = replayBreadth.l0Annotated[0] as typeof replayRouter.l0Annotated[number]
assert.equal(liveBreadthCandidate.strategy_evaluable_vector?.[spec.id], 1)
assert.equal(replayBreadthCandidate.strategy_evaluable_vector?.[spec.id], 0)

assert.deepEqual(resolveMarketScreenerEvidenceMode(undefined, { observedTaipeiDate: '2026-08-15' }), {
  runDate: '2026-08-15',
  evidenceMode: 'live_current',
})
assert.deepEqual(resolveMarketScreenerEvidenceMode('2026-08-14', { observedTaipeiDate: '2026-08-15' }), {
  runDate: '2026-08-14',
  evidenceMode: 'historical_replay',
})
assert.deepEqual(resolveMarketScreenerEvidenceMode('2026-08-15', {
  observedTaipeiDate: '2026-08-15',
  evidenceMode: 'historical_replay',
}), {
  runDate: '2026-08-15',
  evidenceMode: 'historical_replay',
})
