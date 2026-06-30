import { DEFAULT_STRATEGY_SPECS } from './strategySpec'
import * as fs from 'node:fs'
import {
  buildStrategyAdaptivePolicyState,
  buildStrategyDecisionRows,
  buildStrategyRewardLedgerRows,
  evaluateStrategyPromotionGate,
  listStrategySpecsForLearning,
  registryRowToStrategySpec,
  seedDefaultStrategySpecRegistry,
  strategySpecToRegistryRow,
  type StrategySpecRegistryRow,
  type StrategyLearningSummary,
} from './strategyLearning'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeStrategyRegistryStatement {
  constructor(
    private readonly db: FakeStrategyRegistryD1,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStrategyRegistryStatement {
    return new FakeStrategyRegistryStatement(this.db, this.sql, args)
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql
    if (sql.includes('INSERT INTO strategy_spec_registry')) {
      const row = this.db.rowFromInsertArgs(this.args)
      const key = `${row.strategy_id}:${row.version}`
      const existing = this.db.rows.get(key)
      if (existing) {
        row.status = existing.status
        row.owner_type = existing.owner_type
        row.promotion_status = existing.promotion_status
      }
      this.db.rows.set(key, row)
      return { meta: { changes: 1 } }
    }
    if (sql.includes('WHERE strategy_id=?')) {
      const [updatedAt, strategyId] = this.args
      let changes = 0
      for (const row of this.db.rows.values()) {
        if (row.strategy_id === strategyId && row.status !== 'retired') {
          row.status = 'retired'
          row.owner_type = 'retired'
          row.promotion_status = 'retired'
          row.updated_at = String(updatedAt)
          changes += 1
        }
      }
      return { meta: { changes } }
    }
    if (sql.includes('strategy_id NOT IN')) {
      const [updatedAt, ...approvedIds] = this.args.map(String)
      const approved = new Set(approvedIds)
      let changes = 0
      for (const row of this.db.rows.values()) {
        const sourceRefs = JSON.parse(row.source_refs_json || '[]') as string[]
        const generated =
          row.strategy_id.startsWith('finlab_ai_skill_')
          || row.created_by === 'finlab_ai_skill_discovery_v1'
          || sourceRefs.some((ref) => String(ref).includes('finlab_ai_skill'))
        if (row.status !== 'retired' && !approved.has(row.strategy_id) && generated) {
          row.status = 'retired'
          row.owner_type = 'retired'
          row.promotion_status = 'retired'
          row.updated_at = String(updatedAt)
          changes += 1
        }
      }
      return { meta: { changes } }
    }
    return { meta: { changes: 0 } }
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM strategy_spec_registry')) {
      return { results: [...this.db.rows.values()] as T[] }
    }
    return { results: [] }
  }
}

class FakeStrategyRegistryD1 {
  readonly rows = new Map<string, StrategySpecRegistryRow>()

  prepare(sql: string): FakeStrategyRegistryStatement {
    return new FakeStrategyRegistryStatement(this, sql)
  }

  rowFromInsertArgs(args: unknown[]): StrategySpecRegistryRow {
    const [
      strategy_id,
      version,
      name,
      status,
      owner,
      alpha_bucket,
      family_id,
      variant_id,
      owner_type,
      promotion_status,
      supported_regimes_json,
      thesis,
      thresholds_json,
      candidate_policy_json,
      risk_notes_json,
      source_refs_json,
      created_by,
      created_at,
      updated_at,
    ] = args
    return {
      strategy_id: String(strategy_id),
      version: String(version),
      name: String(name),
      status: status as StrategySpecRegistryRow['status'],
      owner: owner as StrategySpecRegistryRow['owner'],
      alpha_bucket: String(alpha_bucket),
      family_id: family_id as StrategySpecRegistryRow['family_id'],
      variant_id: String(variant_id),
      owner_type: owner_type as StrategySpecRegistryRow['owner_type'],
      promotion_status: promotion_status as StrategySpecRegistryRow['promotion_status'],
      supported_regimes_json: String(supported_regimes_json),
      thesis: String(thesis),
      thresholds_json: String(thresholds_json),
      candidate_policy_json: String(candidate_policy_json),
      risk_notes_json: String(risk_notes_json),
      source_refs_json: String(source_refs_json),
      created_by: String(created_by),
      created_at: String(created_at),
      updated_at: String(updated_at),
    }
  }
}

{
  const source = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
  assert(
    source.includes('INSERT OR REPLACE INTO strategy_decision_log'),
    'strategy decision materialization must be idempotent across historical replay runs',
  )
  assert(source.includes('STRATEGY_LEARNING_D1_BATCH_SIZE'), 'strategy learning replay writes must be chunked for D1 production latency')
  assert(source.includes('STRATEGY_LEARNING_DEFAULT_CANDIDATE_LIMIT = 2000'), 'strategy learning must default to full L0 universe scale, not the old 500-candidate partial cap')
  assert(source.includes('STRATEGY_LEARNING_D1_BATCH_SIZE = 250'), 'strategy learning D1 writes must avoid excessive 50-row round trips that can be killed in callback waitUntil')
  assert(source.includes('await db.batch(chunk)'), 'strategy learning replay must use D1 batch persistence')
  assert(
    source.includes('screener_funnel_items') &&
      source.includes("stage = 'scoring' AND decision = 'pass'") &&
      source.includes("stage = 'layer1_strategy_breadth_gate' AND decision = 'pass'") &&
      source.includes("stage = 'final_selection' AND decision = 'selected'") &&
      source.includes('raw_signals') &&
      source.includes('funnel_candidates') &&
      source.includes('fc.evidence AS funnel_evidence'),
    'strategy learning candidates must restore raw L0 scoring/pass strategy evidence from the latest screener funnel, not Score V2-only recommendations or L2 owner stages',
  )
  assert(
    source.includes('retireGeneratedDiscoveryStrategySpecs') &&
      source.includes("SET status='retired'") &&
      source.includes("strategy_id NOT IN (${placeholders})") &&
      source.includes("source_refs_json LIKE '%finlab_ai_skill%'") &&
      source.includes('demoted_stale_active'),
    'strategy registry seeding must retire stale generated FinLab AI discovery rows that are not source-approved production specs',
  )
  assert(
    !source.includes('default_fallback') &&
      !source.includes('DEFAULT_STRATEGY_SPECS.filter((spec) => !registryKeys.has') &&
      source.includes('strategy_spec_registry_empty_seed_required') &&
      source.includes('strategy_spec_registry_no_runtime_specs_seed_required') &&
      source.includes('strategy_spec_registry_contains_stale_generated_rows_seed_required') &&
      source.includes('strategy_spec_registry_contains_stale_runtime_rows_seed_required') &&
      source.includes('candidate_policy_json'),
    'runtime strategy specs must come from D1 registry only; code defaults are seed manifests, not silent screener fallback',
  )
}

{
  const activeSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active')
  const candidateSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'candidate')
  assert(activeSpecs.length === 5, 'bootstrap strategy manifest should expose exactly 5 base production strategies')
  assert(candidateSpecs.length === 3, 'bootstrap strategy manifest should keep the demoted FinLab owners in candidate pool')
  assert(activeSpecs.filter((spec) => spec.id.startsWith('research_consolidated_')).length === 0, 'research consolidated strategies must not remain in bootstrap runtime defaults')
  assert(activeSpecs.filter((spec) => spec.id.startsWith('alphabuilders_multifactor_')).length === 1, 'bootstrap should keep only the retained AlphaBuilders production label')
  assert(activeSpecs.filter((spec) => spec.id.startsWith('alpha_miner_pymoo_nsga3_novelty_')).length === 0, 'pymoo mined strategies must live in D1 registry/migration, not TS bootstrap defaults')
  assert(activeSpecs.some((spec) => spec.id === 'trend_following_seed_v1'), 'existing active strategies must stay active')
  assert(!activeSpecs.some((spec) => spec.id === 'finlab_ai_skill_discovery_v1'), 'daily factor/strategy discovery lane must not remain active')
}

async function runStrategyRegistrySeedContractTest(): Promise<void> {
  const fakeDb = new FakeStrategyRegistryD1()
  fakeDb.rows.set('finlab_ai_skill_generated_duplicate_v1:strategy-spec-v1', {
    strategy_id: 'finlab_ai_skill_generated_duplicate_v1',
    version: 'strategy-spec-v1',
    name: 'Generated duplicate',
    status: 'research',
    owner: 'strategy',
    alpha_bucket: 'trend_following',
    family_id: 'TREND_RECLAIM_CONTINUATION',
    variant_id: 'finlab_ai_skill_generated_duplicate_v1',
    owner_type: 'strategy',
    promotion_status: 'production',
    supported_regimes_json: '["bull"]',
    thesis: 'Stale generated discovery row should not remain a runtime strategy.',
    thresholds_json: '{}',
    candidate_policy_json: '{}',
    risk_notes_json: '[]',
    source_refs_json: '["finlab_ai_skill_discovery_v1"]',
    created_by: 'finlab_ai_skill_discovery_v1',
    created_at: '2026-06-03T00:00:00.000Z',
    updated_at: '2026-06-03T00:00:00.000Z',
  })

  let staleGuardTriggered = false
  try {
    await listStrategySpecsForLearning(fakeDb as unknown as D1Database)
  } catch (error) {
    staleGuardTriggered = String(error).includes('strategy_spec_registry_contains_stale_generated_rows_seed_required')
  }
  assert(staleGuardTriggered, 'runtime reader must fail closed when stale generated discovery rows remain in D1')

  const seedReport = await seedDefaultStrategySpecRegistry(fakeDb as unknown as D1Database, {
    nowIso: '2026-06-16T00:00:00.000Z',
  })
  const expectedActiveCount = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active').length
  const expectedCandidateCount = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'candidate').length
  const { specs, registryRowCount, activeCount } = await listStrategySpecsForLearning(fakeDb as unknown as D1Database)
  assert(seedReport.seeded === DEFAULT_STRATEGY_SPECS.length, 'seed should write the full source-approved registry manifest')
  assert(seedReport.demoted_stale_active === 1, 'seed should retire stale generated discovery rows outside the approved runtime set')
  assert(registryRowCount === DEFAULT_STRATEGY_SPECS.length + 1, 'registry should preserve retired history while exposing clean runtime specs')
  assert(specs.length === DEFAULT_STRATEGY_SPECS.length, 'runtime reader should expose the bootstrap manifest after clean seed when no mined D1 strategies are present')
  assert(activeCount === expectedActiveCount, 'runtime reader active count should equal active bootstrap manifest size after clean seed')
  assert(specs.filter((spec) => spec.status === 'candidate').length === expectedCandidateCount, 'runtime reader should preserve candidate bootstrap specs after clean seed')
  assert(specs.every((spec) => spec.candidatePolicy && Object.keys(spec.candidatePolicy).length > 0), 'every runtime strategy must carry candidate policy from D1')
  assert(!specs.some((spec) => spec.id === 'finlab_ai_skill_discovery_v1'), 'retired discovery lane must not be visible to runtime reader')

  const preserveDb = new FakeStrategyRegistryD1()
  const retiredSpec = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'trend_following_seed_v1')
  assert(retiredSpec, 'test fixture must include trend_following_seed_v1')
  const retiredRow = strategySpecToRegistryRow(retiredSpec, '2026-06-16T00:00:00.000Z')
  retiredRow.status = 'retired'
  retiredRow.owner_type = 'retired'
  retiredRow.promotion_status = 'retired'
  preserveDb.rows.set(`${retiredRow.strategy_id}:${retiredRow.version}`, retiredRow)
  await seedDefaultStrategySpecRegistry(preserveDb as unknown as D1Database, {
    nowIso: '2026-06-16T00:01:00.000Z',
  })
  const preserved = preserveDb.rows.get(`${retiredRow.strategy_id}:${retiredRow.version}`)
  assert(preserved?.status === 'retired', 'registry seed must not resurrect D1-retired production strategies')
  assert(preserved?.owner_type === 'retired', 'registry seed must preserve retired owner_type')
  assert(preserved?.promotion_status === 'retired', 'registry seed must preserve retired promotion status')
}

runStrategyRegistrySeedContractTest().catch((error) => {
  throw error
})

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
  const spec = DEFAULT_STRATEGY_SPECS.find((row) => row.id === 'alphabuilders_multifactor_revenue_quality_momentum_v1')
  assert(spec != null, 'retained AlphaBuilders revenue quality momentum default spec should exist')
  const registryRow = strategySpecToRegistryRow(spec!, '2026-06-03T00:00:00.000Z')
  const restored = registryRowToStrategySpec(registryRow)
  assert(
    restored.familyId === 'REVENUE_QUALITY_MOMENTUM',
    'registry conversion must preserve default family governance for retained AlphaBuilders strategy',
  )
  assert(restored.ownerType === 'strategy', 'registry conversion must preserve production ownerType for default active specs')
  assert(restored.variantId === spec!.variantId, 'registry conversion must preserve variantId for default active specs')
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
  assert(restored.status === 'shadow', 'registry conversion must preserve D1 status instead of silently restoring code default')
  assert(restored.thresholds.minSeedScore === 58, 'registry conversion must expose stale Score V2 thresholds so runtime seed guard can fail closed')
  assert(restored.candidatePolicy?.poolQuota === DEFAULT_STRATEGY_SPECS[0].candidatePolicy?.poolQuota, 'registry conversion should preserve candidate policy stored in D1 row')
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
