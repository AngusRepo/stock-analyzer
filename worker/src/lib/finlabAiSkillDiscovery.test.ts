import {
  buildFinLabRawFactorMinerDiscoveryPackets,
  buildFinLabOfficialStrategyDiscoveryPackets,
  buildFinLabAiSkillDiscoveryBridgePacket,
  FINLAB_AI_SKILL_DISCOVERY_ID,
  parseFinLabOfficialStrategyCatalog,
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

const officialStrategyFirestorePayload = {
  fields: {
    strategies: {
      mapValue: {
        fields: {
          '財報指標20大': {
            mapValue: {
              fields: {
                name: { stringValue: '財報指標20大' },
                annual_return: { doubleValue: 0.25 },
                sharpe_ratio: { doubleValue: 1.52 },
                max_drawdown: { doubleValue: -0.27 },
                public_code: { integerValue: '2' },
                public_position: { integerValue: '2' },
                public_performance: { integerValue: '0' },
                ndays_return: {
                  mapValue: {
                    fields: {
                      '20': { doubleValue: 0.08 },
                    },
                  },
                },
              },
            },
          },
          '精選00733強勢股': {
            mapValue: {
              fields: {
                name: { stringValue: '精選00733強勢股' },
                annual_return: { doubleValue: 0.36 },
                sharpe_ratio: { doubleValue: 1.06 },
                max_drawdown: { doubleValue: -0.42 },
                public_code: { integerValue: '2' },
                public_position: { integerValue: '2' },
                public_performance: { integerValue: '0' },
              },
            },
          },
          '高回撤測試策略': {
            mapValue: {
              fields: {
                name: { stringValue: '高回撤測試策略' },
                annual_return: { doubleValue: 0.45 },
                sharpe_ratio: { doubleValue: 1.2 },
                max_drawdown: { doubleValue: -0.5 },
                public_code: { integerValue: '2' },
                public_position: { integerValue: '2' },
                public_performance: { integerValue: '0' },
              },
            },
          },
        },
      },
    },
    tags: {
      mapValue: {
        fields: {
          '財報指標20大': {
            arrayValue: {
              values: [
                { mapValue: { fields: { text: { stringValue: '基本面' } } } },
                { mapValue: { fields: { text: { stringValue: '台股' } } } },
              ],
            },
          },
          '精選00733強勢股': {
            arrayValue: {
              values: [
                { mapValue: { fields: { text: { stringValue: '台股' } } } },
                { mapValue: { fields: { text: { stringValue: 'ETF' } } } },
              ],
            },
          },
          '高回撤測試策略': {
            arrayValue: {
              values: [
                { mapValue: { fields: { text: { stringValue: '台股' } } } },
                { mapValue: { fields: { text: { stringValue: '技術面' } } } },
              ],
            },
          },
        },
      },
    },
  },
}

{
  const strategies = parseFinLabOfficialStrategyCatalog(officialStrategyFirestorePayload)
  assert(strategies.length === 3, 'official FinLab catalog parser should read all strategy rows')
  assert(strategies[0].market === 'TW', 'official FinLab catalog parser should infer TW market from tags')
  assert(strategies[0].public_code === 2, 'official FinLab catalog parser should preserve permission levels')

  const packets = buildFinLabOfficialStrategyDiscoveryPackets(strategies, '2026-06-01', '2026-06-01T12:00:00.000Z')
  assert(packets.length === 2, 'official strategy discovery should exclude ETF-tagged strategies from Taiwan screener ingestion')
  const packet = packets[0]
  assert(packet.ok, `official FinLab strategy packet should be valid: ${packet.errors.join(',')}`)
  assert(packet.strategy_spec.id.startsWith('finlab_ai_skill_official_'), 'official strategy packets should use FinLab-scoped ids')
  assert(packet.strategy_spec.status === 'active', 'official strategies that pass the user-approved metric gate should become active')
  assert(packet.strategy_spec.thresholds.includeIndustries == null, 'official strategy tags such as 基本面 must not be misused as industry filters')
  assert(packet.strategy_spec.thresholds.minSeedScore == null, 'official strategy packets must not inject Score V2 seed thresholds')
  assert(packet.research_experiment.source_refs.some((ref) => ref.includes('finlab_official_sid:財報指標20大')), 'official strategy lineage should preserve FinLab sid')
  assert((packet.strategy_spec.candidatePolicy?.maxMlShare ?? 1) > 0, 'active official strategies should enter the L1/L2 production path')
  assert(packet.bridge.production_effect === true, 'active official strategy packets should disclose production effect')
  const highDrawdownPacket = packets.find((row) => row.strategy_spec.id.includes('高回撤測試策略'))
  assert(highDrawdownPacket?.strategy_spec.status === 'research', 'official strategies with drawdown worse than 40% should stay research')
}

{
  const rawFactorPayload = {
    version: 'finlab-ai-factor-miner-v1',
    generated_at: '2026-06-01T00:00:00+00:00',
    checksum: 'sha256:test',
    production_effect: false,
    candidates: [
      {
        candidate_id: 'finlab_ai_factor_technical_rsi14',
        lane: 'technical',
        query: 'RSI',
        dataset_key: 'technical:rsi14',
        display_name: 'RSI 14',
        hypothesis: 'Mine RSI reversal as a research-only L1 strategy candidate.',
        alpha_bucket: 'trend_following',
        evidence_requirements: ['finlab_api_search', 'raw_technical_indicator_mining', 'pbo', 'reality_check'],
        source_refs: ['finlab.data.search:RSI', 'dataset:technical:rsi14'],
        production_effect: false,
      },
      {
        candidate_id: 'finlab_ai_factor_chip_foreign_net',
        lane: 'chip',
        query: '外資',
        dataset_key: 'institutional:foreign_net_buy',
        display_name: 'foreign net buy',
        alpha_bucket: 'defensive_accumulation',
        evidence_requirements: ['raw_chip_flow', 'raw_broker_flow'],
        source_refs: ['dataset:institutional:foreign_net_buy'],
      },
      {
        candidate_id: 'finlab_ai_factor_fundamental_roe',
        lane: 'fundamental',
        query: 'ROE',
        dataset_key: 'fundamental:roe',
        display_name: 'ROE',
        evidence_requirements: ['raw_profitability', 'raw_valuation'],
      },
    ],
  }

  const packets = buildFinLabRawFactorMinerDiscoveryPackets(rawFactorPayload, '2026-06-01', '2026-06-01T12:00:00.000Z')
  assert(packets.length === 3, 'raw-factor miner payload should materialize every valid candidate')
  const techPacket = packets[0]
  assert(techPacket.ok, `raw-factor technical packet should be valid: ${techPacket.errors.join(',')}`)
  assert(techPacket.strategy_spec.status === 'research', 'raw-factor miner specs must stay research until promotion evidence exists')
  assert(techPacket.strategy_spec.candidatePolicy?.maxMlShare === 0, 'raw-factor research specs must not enter L2 ML queue directly')
  assert(techPacket.strategy_spec.thresholds.includeIndustries == null, 'raw-factor datasets must not be misused as industry filters')
  assert(techPacket.strategy_spec.thresholds.minSeedScore == null, 'raw-factor miner specs must not inject Score V2 seed thresholds')
  assert(techPacket.strategy_spec.thresholds.minTechnicalIndicators?.rsi14 === 35, 'technical raw-factor packet should expose RSI threshold hints')
  assert(techPacket.research_experiment.source_refs.some((ref) => ref.includes('miner_checksum:sha256:test')), 'raw-factor lineage should preserve miner checksum')
  assert(techPacket.research_experiment.source_refs.some((ref) => ref.includes('dataset:technical:rsi14')), 'raw-factor lineage should preserve dataset key')
  assert(techPacket.bridge.production_effect === false, 'raw-factor miner ingestion must be non-production mutating')
  assert(
    packets.some((packet) => packet.strategy_spec.thresholds.minForeignTrustNet5d === 0),
    'chip raw-factor packets should emit chip-flow threshold hints',
  )
  assert(
    packets.some((packet) => packet.strategy_spec.thresholds.minRoe === 3),
    'fundamental raw-factor packets should emit fundamental threshold hints',
  )
}

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
  assert(packet.strategy_spec.thresholds.minSeedScore == null, 'FinLab AI Skill discovery must not inject Score V2 seed thresholds')
  assert(packet.strategy_spec.thresholds.minTechScore == null, 'FinLab AI Skill discovery must not inject old technical score thresholds')
  assert(packet.strategy_spec.candidatePolicy?.maxMlShare === 0, 'research discovery specs must not enter ML queue directly')
  assert(
    packet.strategy_spec.candidatePolicy?.evidenceRequirements?.includes('raw_factor_mining'),
    'FinLab AI Skill discovery should record raw factor mining evidence',
  )
  assert(
    packet.strategy_spec.candidatePolicy?.evidenceRequirements?.includes('raw_technical_indicator_mining'),
    'FinLab AI Skill discovery should record technical indicator mining evidence',
  )
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
      raw_signals: {
        volumeExpansion20: 1.1,
        closeAboveMa20Pct: 0.02,
        factorSignals: { monthly_revenue_yoy_acceleration: 1.2 },
        technicalIndicators: { rsi14: 55 },
      },
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
      raw_signals: {
        volumeExpansion20: 1.1,
        closeAboveMa20Pct: 0.02,
        factorSignals: { monthly_revenue_yoy_acceleration: 1.2 },
        technicalIndicators: { rsi14: 55 },
      },
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
    includeOfficialStrategies: false,
  })

  assert(report.status === 'persisted', 'FinLab AI Skill discovery closure should persist approved research metadata')
  assert(report.packets.length === 1, 'FinLab taxonomy search should create one discovery packet')
  assert(report.packets[0].strategy_spec.status === 'research', 'auto search must persist generated specs as research first')
  assert(report.persisted.research_experiments === 1, 'auto search should write research experiment metadata')
  assert(report.persisted.strategy_specs === 1, 'auto search should upsert research strategy spec into strategy_spec_registry')
  assert([...env.KV.store.keys()].some((key) => key.startsWith('research:experiments:')), 'research experiment should be stored in KV')
  assert(calls.some((call) => call.includes('INSERT INTO strategy_spec_registry')), 'strategy spec should be upserted into D1 registry')
})()

void (async () => {
  const calls: string[] = []
  const env = {
    DB: { prepare: (sql: string) => new FakeDiscoveryStatement(sql, calls) },
    KV: new FakeDiscoveryKV(),
  }
  const report = await runFinLabAiSkillDiscoveryClosure(env as any, '2026-06-01', {
    dryRun: false,
    limit: 1,
    includeOfficialStrategies: false,
    rawFactorMinerPayload: {
      version: 'finlab-ai-factor-miner-v1',
      generated_at: '2026-06-01T00:00:00+00:00',
      checksum: 'sha256:raw-factor-test',
      candidates: [
        {
          candidate_id: 'finlab_ai_factor_technical_rsi14',
          lane: 'technical',
          query: 'RSI',
          dataset_key: 'technical:rsi14',
          display_name: 'RSI 14',
          evidence_requirements: ['raw_technical_indicator_mining', 'pbo'],
        },
      ],
    },
    nowIso: '2026-06-01T12:00:00.000Z',
  })

  assert(report.status === 'persisted', 'closure should persist raw-factor miner discoveries')
  assert(report.source_rows === 2, 'closure source rows should include taxonomy plus raw-factor miner candidates')
  assert(report.packets.some((packet) => packet.strategy_spec.id.includes('raw_factor_')), 'closure should materialize raw-factor strategy specs')
  assert(report.packets.some((packet) => packet.research_experiment.source_refs.some((ref) => ref.includes('miner_checksum:sha256:raw-factor-test'))), 'closure should preserve raw-factor miner checksum')
  assert(report.packets.every((packet) => packet.strategy_spec.status === 'research'), 'raw-factor closure payload must persist research-only specs')
})()

void (async () => {
  const calls: string[] = []
  const env = {
    DB: { prepare: (sql: string) => new FakeDiscoveryStatement(sql, calls) },
    KV: new FakeDiscoveryKV(),
  }
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => officialStrategyFirestorePayload,
    text: async () => JSON.stringify(officialStrategyFirestorePayload),
  })
  const report = await runFinLabAiSkillDiscoveryClosure(env as any, '2026-06-01', {
    dryRun: false,
    limit: 1,
    officialStrategyLimit: 10,
    fetcher: fakeFetch as any,
    nowIso: '2026-06-01T12:00:00.000Z',
  })

  assert(report.status === 'persisted', 'closure should persist taxonomy and official FinLab strategy discoveries')
  assert(report.source_rows === 4, 'closure source rows should include taxonomy plus all official catalog rows before ETF exclusion')
  assert(report.packets.some((packet) => packet.strategy_spec.id.includes('official_')), 'closure should materialize official strategy packets')
  assert(report.packets.some((packet) => packet.research_experiment.source_refs.some((ref) => ref.includes('finlab_official_strategy_page'))), 'closure should preserve official FinLab page source refs')
})()
