import {
  buildFinLabAiSkillDiscoveryBridgePacket,
  FINLAB_AI_SKILL_DISCOVERY_ID,
  runFinLabAiSkillDiscoveryClosure,
} from './finlabAiSkillDiscovery'
import {
  registryRowToStrategySpec,
  strategySpecToRegistryRow,
} from './strategyLearning'
import {
  buildStrategyCandidatePools,
  mergeStrategyCandidatePools,
  resolveStrategyCapacityBudget,
} from './strategyCandidatePool'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const scoreV2 = JSON.stringify({
  version: 'score_v2',
  finalScore: 72,
  components: {
    mlEdge: 12,
    chipFlow: 24,
    technicalStructure: 23,
    fundamentalQuality: 8,
    newsTheme: 5,
  },
  technicalBreakdown: {
    volumeConfirmation: 4,
  },
  seedComponents: {
    screenerMomentumSeed20: 10,
  },
})

{
  const packet = buildFinLabAiSkillDiscoveryBridgePacket({
    hypothesis: 'AI Server taxonomy breadth plus revenue acceleration may form a reusable L1 strategy hypothesis.',
    taxonomyRefs: ['industry_theme:AI Server'],
    factorRefs: ['monthly_revenue_yoy_acceleration'],
    tag: 'AI Server',
    tagType: 'industry_theme',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways'],
    status: 'research',
    nowIso: '2026-05-31T12:00:00.000Z',
  })

  assert(packet.ok, `FinLab AI Skill packet should be valid: ${packet.errors.join(',')}`)
  assert(packet.strategy_spec.id.startsWith('finlab_ai_skill_'), 'generated strategy id should be FinLab scoped')
  assert(packet.strategy_spec.status === 'research', 'auto-discovered specs should default to research status')
  assert(packet.strategy_spec.thresholds.includeIndustries?.includes('AI Server'), 'taxonomy tag should bind the strategy spec to L1 taxonomy matching')
  assert(packet.strategy_spec.candidatePolicy?.maxMlShare === 0, 'research discovery specs must not enter ML queue directly')
  assert(packet.research_experiment.strategy_spec_ids.includes(packet.strategy_spec.id), 'research experiment should reference generated strategy spec')
  assert(packet.research_experiment.source_refs.includes(FINLAB_AI_SKILL_DISCOVERY_ID), 'research experiment should preserve FinLab AI Skill lineage')
  assert(packet.bridge.path_to_screener_layers.includes('strategy_spec_registry'), 'bridge should declare registry path into screener layers')
  assert(packet.bridge.production_effect === false, 'research discovery bridge must be non-production mutating')

  const restored = registryRowToStrategySpec(strategySpecToRegistryRow(packet.strategy_spec, '2026-05-31T12:00:00.000Z', {
    sourceRefs: packet.research_experiment.source_refs,
    createdBy: FINLAB_AI_SKILL_DISCOVERY_ID,
  }))

  const pools = buildStrategyCandidatePools([
    {
      symbol: '9999',
      name: 'TestCo',
      industry: 'AI Server',
      current_price: 100,
      score_v2: scoreV2,
    },
  ], [restored], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length === 0, 'registry-restored research spec must stay out of ML queue')
  assert(selection.researchOnlyQueue.length === 1, 'registry-restored research spec should be observable in research queue')
}

{
  const packet = buildFinLabAiSkillDiscoveryBridgePacket({
    hypothesis: 'AI Server taxonomy breadth plus revenue acceleration passed review and can be evaluated as an L1 candidate strategy.',
    taxonomyRefs: ['industry_theme:AI Server'],
    factorRefs: ['monthly_revenue_yoy_acceleration'],
    tag: 'AI Server',
    tagType: 'industry_theme',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways'],
    status: 'candidate',
    approvedForL1: true,
    nowIso: '2026-05-31T12:00:00.000Z',
  })

  assert(packet.ok, `approved FinLab AI Skill packet should be valid: ${packet.errors.join(',')}`)
  assert(packet.strategy_spec.status === 'candidate', 'approved FinLab discovery can become a candidate strategy spec')
  assert(packet.strategy_spec.candidatePolicy?.maxMlShare !== 0, 'candidate strategy should be eligible for L2 coarse ML queue after L1 breadth')

  const restored = registryRowToStrategySpec(strategySpecToRegistryRow(packet.strategy_spec, '2026-05-31T12:00:00.000Z', {
    sourceRefs: packet.research_experiment.source_refs,
    createdBy: FINLAB_AI_SKILL_DISCOVERY_ID,
  }))

  const pools = buildStrategyCandidatePools([
    {
      symbol: '9999',
      name: 'TestCo',
      industry: 'AI Server',
      current_price: 100,
      score_v2: scoreV2,
    },
  ], [restored], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length === 1, 'approved candidate strategy should enter L2 coarse ML queue through registry path')
}

class FakeDiscoveryStatement {
  private binds: unknown[] = []

  constructor(private readonly sql: string, private readonly calls: string[]) {}

  bind(...values: unknown[]) {
    this.binds = values
    return this
  }

  async run(): Promise<unknown> {
    this.calls.push(`run:${this.sql.slice(0, 48)}`)
    return {}
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    this.calls.push(`all:${this.sql.slice(0, 48)}:${this.binds.join('|')}`)
    if (this.sql.includes('FROM finlab_taxonomy_tags')) {
      return {
        results: [
          {
            tag: 'AI Server',
            tag_type: 'industry_theme',
            symbol_count: 18,
            avg_weight: 0.82,
            latest_as_of_date: '2026-05-31',
          },
        ] as T[],
      }
    }
    return { results: [] }
  }
}

class FakeDiscoveryKV {
  store = new Map<string, string>()

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async get(): Promise<null> {
    return null
  }

  async list(): Promise<{ keys: unknown[] }> {
    return { keys: [] }
  }
}

void (async () => {
  const calls: string[] = []
  const env = {
    DB: { prepare: (sql: string) => new FakeDiscoveryStatement(sql, calls) },
    KV: new FakeDiscoveryKV(),
  }
  const report = await runFinLabAiSkillDiscoveryClosure(env as any, '2026-05-31', {
    dryRun: false,
    limit: 1,
    nowIso: '2026-05-31T12:00:00.000Z',
  })

  assert(report.status === 'persisted', 'FinLab AI Skill discovery closure should persist approved research metadata')
  assert(report.packets.length === 1, 'FinLab taxonomy search should create one discovery packet')
  assert(report.packets[0].strategy_spec.status === 'research', 'auto search must persist generated specs as research first')
  assert(report.persisted.research_experiments === 1, 'auto search should write research experiment metadata')
  assert(report.persisted.strategy_specs === 1, 'auto search should upsert research strategy spec into strategy_spec_registry')
  assert([...env.KV.store.keys()].some((key) => key.startsWith('research:experiments:')), 'research experiment should be stored in KV')
  assert(calls.some((call) => call.includes('INSERT INTO strategy_spec_registry')), 'strategy spec should be upserted into D1 registry')
})()
