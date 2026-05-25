import { DEFAULT_STRATEGY_SPECS } from './strategySpec'
import {
  buildStrategyAdaptivePolicyState,
  buildStrategyDecisionRows,
  buildStrategyRewardLedgerRows,
  evaluateStrategyPromotionGate,
  registryRowToStrategySpec,
  strategySpecToRegistryRow,
  type StrategyLearningSummary,
} from './strategyLearning'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const spec = DEFAULT_STRATEGY_SPECS[0]
  const row = strategySpecToRegistryRow(spec, '2026-05-19T00:00:00.000Z')
  const restored = registryRowToStrategySpec(row)
  assert(restored.id === spec.id, 'registry conversion should preserve strategy id')
  assert(restored.name === spec.name, 'registry conversion should preserve strategy display name')
  assert(restored.status === spec.status, 'registry conversion should preserve status')
  assert(restored.candidatePolicy?.poolQuota === spec.candidatePolicy?.poolQuota, 'registry conversion should restore candidate-pool policy for default specs')
}

{
  const rows = buildStrategyDecisionRows(
    '2026-05-19',
    [
      {
        symbol: '2330',
        name: 'TSMC',
        current_price: 900,
        score_v2: JSON.stringify({
          version: 'score_v2',
          finalScore: 70,
          components: {
            mlEdge: 12,
            chipFlow: 25,
            technicalStructure: 24,
            fundamentalQuality: 8,
            newsTheme: 1,
          },
          technicalBreakdown: {
            volumeConfirmation: 4,
          },
          seedComponents: {
            screenerMomentumSeed20: 12,
          },
        }),
      },
    ],
    DEFAULT_STRATEGY_SPECS,
    { nowIso: '2026-05-19T00:00:00.000Z' },
  )
  assert(rows.length === DEFAULT_STRATEGY_SPECS.length, 'decision log should evaluate every strategy spec')
  assert(rows.some((row) => row.matched === 1), 'strong candidate should match at least one strategy')
  assert(rows.every((row) => row.decision_id.includes('2026-05-19-2330')), 'decision id should include date and symbol')
}

{
  const rows = buildStrategyDecisionRows(
    '2026-05-19',
    [
      {
        symbol: '2330',
        name: 'TSMC',
        current_price: 900,
        score_v2: JSON.stringify({
          version: 'score_v2',
          finalScore: 70,
          components: {
            mlEdge: 12,
            chipFlow: 24,
            technicalStructure: 22,
            fundamentalQuality: 10,
            newsTheme: 2,
          },
          technicalBreakdown: {
            trendStructure: 6,
            volatilityStructure: 4,
            reversalExtreme: 4,
            volumeConfirmation: 3,
            executionRisk: 1,
          },
          seedComponents: {
            screenerMomentumSeed20: 10,
          },
        }),
      },
    ],
    DEFAULT_STRATEGY_SPECS,
    { nowIso: '2026-05-19T00:00:00.000Z' },
  )
  const matched = rows.find((row) => row.matched === 1)
  assert(matched != null, 'strategy learning should match by canonical Score V2 when legacy fields are stale')
  const context = JSON.parse(matched.context_json)
  assert(context.candidate.score_v2.source === 'score_v2', 'decision context should record Score V2 as the strategy score source')
  assert(context.candidate.score_v2.finalScore === 70, 'decision context should persist canonical strategy seed score')
  assert(context.candidate.score_v2.chipFlow === 24, 'decision context should persist Score V2 chipFlow')
  assert(context.candidate.score_v2.technicalStructure === 22, 'decision context should persist Score V2 technicalStructure')
  assert(!('chip_score' in context.candidate), 'decision context must not persist legacy chip_score')
  assert(!('tech_score' in context.candidate), 'decision context must not persist legacy tech_score')
  assert(!('momentum_score' in context.candidate), 'decision context must not persist legacy momentum_score')
}

{
  const ledger = buildStrategyRewardLedgerRows([
    {
      date: '2026-05-15',
      symbol: '2330',
      strategy_id: 'trend_following_seed_v1',
      strategy_version: 'strategy-spec-v1',
      strategy_status: 'shadow',
      alpha_bucket: 'trend_following',
      market_segment: 'LISTED',
      actual_return_pct: 0.02,
    },
    {
      date: '2026-05-16',
      symbol: '2317',
      strategy_id: 'trend_following_seed_v1',
      strategy_version: 'strategy-spec-v1',
      strategy_status: 'shadow',
      alpha_bucket: 'trend_following',
      market_segment: 'LISTED',
      actual_return_pct: -0.01,
    },
  ], { nowIso: '2026-05-19T00:00:00.000Z' })
  assert(ledger.length === 1, 'ledger should aggregate rows by strategy/version/segment/regime')
  assert(ledger[0].samples === 2, 'ledger should count reward samples')
  assert(ledger[0].hit_rate === 0.5, 'ledger should compute hit rate')
  assert(ledger[0].avg_return_pct === 0.005, 'ledger should compute average return')
}

{
  const spec = DEFAULT_STRATEGY_SPECS[0]
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: {
        decisions: 80,
        matched: 24,
        match_rate: 0.3,
        samples: 45,
        hit_rate: 0.62,
        avg_return_pct: 0.018,
        max_drawdown_pct: -0.03,
        status: 'learning',
      },
    }],
    promotion_gate: [],
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'candidate_ready', 'strong strategy evidence should be candidate-ready')
  assert(gate[0].requires_wei_approval === true, 'strategy promotion should require Wei approval')
  assert(gate[0].current_stage === 'L1_shadow', 'shadow strategy should be L1')
  assert(gate[0].recommended_stage === 'L2_paper_active', 'ready shadow strategy should advance to L2 paper-active')
  assert(gate[0].l3_requires_wei_approval === false, 'L2 paper-active does not equal production allocation')
  assert(gate[0].production_effect === false, 'strategy gate must not mutate production')

  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(policy.status === 'shadow', 'adaptive policy should remain shadow by default')
  assert(policy.evidence.production_effect === false, 'adaptive policy preview must not affect production')
  assert(policy.evidence.requires_approval_to_activate === true, 'adaptive policy activation should require approval')
  assert(Math.abs(Object.values(policy.strategy_weights).reduce((sum, weight) => sum + weight, 0) - 1) < 0.00001, 'strategy weights should normalize to 1')
}

{
  const spec = DEFAULT_STRATEGY_SPECS[0]
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: {
        decisions: 3,
        matched: 1,
        match_rate: 0.333333,
        samples: 2,
        hit_rate: 0.5,
        avg_return_pct: -0.01,
        max_drawdown_pct: -0.12,
        status: 'learning',
      },
    }],
    promotion_gate: [],
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'not_ready', 'weak evidence should not be ready for strategy promotion')
  assert(gate[0].recommended_stage === 'L1_shadow', 'weak shadow evidence should stay at L1')
  assert(gate[0].missing_evidence.includes('samples_lt_30'), 'gate should expose sample shortage')
  assert(gate[0].missing_evidence.includes('avg_return_not_positive'), 'gate should expose weak reward evidence')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'candidate' as const }
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: {
        decisions: 80,
        matched: 24,
        match_rate: 0.3,
        samples: 45,
        hit_rate: 0.62,
        avg_return_pct: 0.018,
        max_drawdown_pct: -0.03,
        status: 'learning',
      },
    }],
    promotion_gate: [],
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].recommended_stage === 'L3_production_allocation', 'ready candidate strategy should request L3')
  assert(gate[0].l3_requires_wei_approval === true, 'L3 production allocation must require Wei approval')
  assert(gate[0].production_effect === false, 'L3 gate is still metadata until approved')
}
