import { DEFAULT_STRATEGY_SPECS } from './strategySpec'
import * as fs from 'node:fs'
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
  const source = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
  assert(
    source.includes('INSERT OR REPLACE INTO strategy_decision_log'),
    'strategy decision materialization must be idempotent across historical replay runs',
  )
  assert(source.includes('STRATEGY_LEARNING_D1_BATCH_SIZE'), 'strategy learning replay writes must be chunked for D1 production latency')
  assert(source.includes('await db.batch(chunk)'), 'strategy learning replay must use D1 batch persistence')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
  const row = strategySpecToRegistryRow(spec, '2026-05-19T00:00:00.000Z')
  const restored = registryRowToStrategySpec(row)
  assert(restored.id === spec.id, 'registry conversion should preserve strategy id')
  assert(restored.name === spec.name, 'registry conversion should preserve strategy display name')
  assert(restored.status === spec.status, 'registry conversion should preserve status')
  assert(restored.candidatePolicy?.poolQuota === spec.candidatePolicy?.poolQuota, 'registry conversion should restore candidate-pool policy for default specs')
}

{
  const staleLegacyRow = strategySpecToRegistryRow({
    ...DEFAULT_STRATEGY_SPECS[0],
    status: 'shadow' as const,
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
  }, '2026-05-21T00:00:00.000Z', {
    sourceRefs: ['codex_seed_2026_05_22'],
  })
  const restored = registryRowToStrategySpec(staleLegacyRow)
  assert(restored.status === 'active', 'stale legacy default registry row must not override newer active default spec')
  assert(restored.thresholds.minSeedScore == null, 'stale legacy default registry row must not keep Score V2 seed threshold')
  assert(restored.thresholds.minCloseAboveMa20Pct === 0, 'stale legacy default registry row should restore raw active threshold')
}

{
  const rows = buildStrategyDecisionRows(
    '2026-05-19',
    [
      {
        symbol: '2330',
        name: 'TSMC',
        current_price: 900,
        raw_signals: {
          closeAboveMa20Pct: 0.03,
          closeAboveMa60Pct: 0.02,
          volumeExpansion20: 1.25,
          return20d: 0.06,
          foreignTrustNet5d: 1000,
          brokerCount: 8,
          revenueGrowthYoY: 8,
          roe: 12,
        },
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
        raw_signals: {
          closeAboveMa20Pct: 0.03,
          closeAboveMa60Pct: 0.02,
          volumeExpansion20: 1.25,
          return20d: 0.06,
          foreignTrustNet5d: 1000,
          brokerCount: 8,
          revenueGrowthYoY: 8,
          roe: 12,
        },
      },
    ],
    DEFAULT_STRATEGY_SPECS,
    { nowIso: '2026-05-19T00:00:00.000Z' },
  )
  const matched = rows.find((row) => row.matched === 1)
  assert(matched != null, 'strategy learning should match by raw strategy signals')
  const context = JSON.parse(matched.context_json)
  assert(context.candidate.raw_signals.volumeExpansion20 === 1.25, 'decision context should persist raw volume evidence')
  assert(context.candidate.raw_signals.closeAboveMa20Pct === 0.03, 'decision context should persist raw price structure evidence')
  assert(!('score_v2' in context.candidate), 'decision context must not use Score V2 as L1 strategy evidence')
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
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
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
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
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

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'active' as const }
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: {
        decisions: 90,
        matched: 20,
        match_rate: 0.222222,
        samples: 45,
        hit_rate: 0.44,
        avg_return_pct: -0.006,
        max_drawdown_pct: -0.11,
        status: 'learning',
      },
    }],
    promotion_gate: [],
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'active_cooldown', 'weak active strategy evidence should trigger cooldown')
  assert(gate[0].recommended_next_status === 'candidate', 'active cooldown should recommend demotion to candidate')
  assert(gate[0].recommended_stage === 'L2_paper_active', 'cooldown should move weak active strategies back to paper-active review')
  assert(gate[0].missing_evidence.includes('active_avg_return_not_positive'), 'cooldown should expose weak return evidence')

  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(policy.strategy_weights[spec.id] === 0.2, 'cooldown strategies should be explicitly down-weighted instead of falling back to default weight')
  assert(policy.threshold_deltas[spec.id].minVolumeExpansion20 === 0.12, 'cooldown should tighten raw-signal thresholds')
}
