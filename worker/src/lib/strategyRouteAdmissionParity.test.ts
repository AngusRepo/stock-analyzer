import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMultiStrategyPleRoutingPlan, STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION } from './multiStrategyPleRouter'
import { strategySpecForSemanticV2Challenger, type StrategySpec } from './strategySpec'
import { type StrategyCandidatePoolCandidate } from './strategyCandidatePool'

const spec: StrategySpec = {
  id: 'alpha223_0009', version: 'strategy-spec-v1', name: 'frozen incumbent', status: 'active',
  owner: 'strategy', ownerType: 'strategy', promotionStatus: 'production',
  familyId: 'ALPHA223_CASH_GAP_BROKER_FLOW', variantId: 'alpha223_0009_cash_gap_broker_flow_v1',
  alphaBucket: 'breakout_vol_expansion', supportedRegimes: ['bull'], thesis: 'synthetic route owner test',
  thresholds: { featureRefs: { weightedScore: { min: .58, terms: [
    { featureRef: 'tech_gap_down', signal: 'factorSignals.techGapDown', weight: .5 },
    { featureRef: 'finlab701_fundamental_features_EBITDA', signal: 'factorSignals.ebitda', weight: .5 },
  ] } } },
  candidatePolicy: { poolQuota: 10, costBudget: 10, evidenceRequirements: [], maxMlShare: .2 },
  riskNotes: [], createdBy: 'p5_strategy_governance',
}

function row(symbol: string, incumbent: number, challenger: number): StrategyCandidatePoolCandidate {
  return { symbol, current_price: 50, market_segment: 'LISTED', eligible_for_ml: 1,
    score_components: JSON.stringify({ version: 'score_v2', finalScore: 60,
      components: { chipFlow: 20, technicalStructure: 20, fundamentalQuality: 10, mlEdge: 12, newsTheme: 2 },
      technicalBreakdown: { trendStructure: 6, volatilityStructure: 4, reversalExtreme: 4, volumeConfirmation: 4, executionRisk: 1 },
      seedComponents: { screenerMomentumSeed20: 10 } }),
    raw_signals: { close: 50, closeAboveMa20Pct: .03, closeAboveMa60Pct: .01,
      volumeExpansion20: 1.25, return20d: .06,
      factorSignals: { techGapDown: incumbent, ebitda: incumbent,
        finlabCsV2TechGapDownNoGapRank: challenger, finlabSectorNeutralV2EbitdaCapitalRank: challenger } },
  }
}

for (const routeFloor of [100, null]) test(`promoting L1.5 priority preserves L1 hits (diagnostic floor ${routeFloor})`, () => {
  const candidates = [row('base-only', .9, .1), row('candidate-only', .1, .9), row('both', .9, .9)]
  const before = structuredClone({ candidates, spec })
  const options = { maxSlateSize: 1, regime: 'bull' as const }
  const baseline = buildMultiStrategyPleRoutingPlan(candidates, [spec], options)
  const promoted = buildMultiStrategyPleRoutingPlan(candidates, [spec], { ...options,
    promotedRouteCalibration: { runId: 'fixture-route-only', routeVersion: STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION, routeFloor } })
  if (routeFloor === 100 && process.argv.includes('--emit-pit-route')) {
    console.log('NAV_ROUTE_FIXTURE=' + JSON.stringify(baseline.l0Annotated.map(row => row.l15_route_contrast)))
    console.log('NAV_ROUTE_INPUTS=' + JSON.stringify({ universe: candidates, specs: [spec] }))
  }
  const symbols = (plan: typeof baseline) => plan.mlSlate.map(r => r.symbol).sort()
  assert.deepEqual(symbols(baseline), ['base-only', 'both'])
  assert.equal(baseline.l0Annotated.find(r => r.symbol === 'base-only')?.strategy_challenger_hit_vector?.[spec.id], 0)
  assert.equal(baseline.l0Annotated.find(r => r.symbol === 'candidate-only')?.strategy_challenger_hit_vector?.[spec.id], 1)
  assert.deepEqual(symbols(promoted), symbols(baseline), 'route artifact must not promote a different Strategy Spec implicitly')
  for (const original of baseline.l0Annotated) {
    const actual = promoted.l0Annotated.find(r => r.symbol === original.symbol)!
    assert.deepEqual(actual.strategy_pool_ids, original.strategy_pool_ids)
    assert.deepEqual(actual.strategy_hit_vector, original.strategy_hit_vector)
    assert.deepEqual(actual.strategy_evaluable_vector, original.strategy_evaluable_vector)
    assert.deepEqual(actual.strategy_position_weight_vector, original.strategy_position_weight_vector)
    assert.equal(actual.strategy_incumbent_route_score, original.strategy_incumbent_route_score)
    assert.equal(actual.strategy_challenger_route_score, original.strategy_challenger_route_score)
    assert.equal(actual.strategy_router_score, actual.strategy_challenger_route_score)
    assert.equal(original.l15_route_contrast?.serving_arm, 'incumbent')
    assert.equal(actual.l15_route_contrast?.serving_arm, 'challenger')
    assert.deepEqual(actual.l15_route_contrast?.incumbent, original.l15_route_contrast?.incumbent)
    assert.deepEqual(actual.l15_route_contrast?.challenger, original.l15_route_contrast?.challenger)
    assert.equal(actual.l15_route_contrast?.incumbent.score, original.strategy_incumbent_route_score)
    assert.equal(actual.l15_route_contrast?.challenger.score, actual.strategy_challenger_route_score)
    assert.equal(actual.l15_route_contrast?.allocation_weight_applied, false)
    assert.equal(actual.l15_route_contrast?.effect_scope, 'dispatch_priority_only')
  }
  assert.equal(promoted.telemetry.route_veto_applied, false)
  assert.deepEqual({ candidates, spec }, before)
  const registryPromoted = buildMultiStrategyPleRoutingPlan(candidates,
    [strategySpecForSemanticV2Challenger(spec)], options)
  assert.deepEqual(symbols(registryPromoted), ['both', 'candidate-only'],
    'Strategy Spec promotion remains owned by the registry, not permanently disabled')
})
