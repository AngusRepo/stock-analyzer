import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLayer1WithAtomicSource, replayAtomicStrategySource, sealAtomicPostOverlaySource } from './atomicStrategyShadow'
import { replayFrozenPostRoute } from './screenerFrozenOverlayReplay'
import { ScreenerOverlayCapture } from './screenerOverlayCapture'
import { applyScreenerNewsSentiment, applyScreenerBuzz, applyScreenerExternalRisk,
  applyScreenerForeignFlow, applyScreenerSelectionHistory, applyScoreV2NewsThemeAdjustment } from './screenerPostRouteOverlays'
import { materializeExternalEvidenceRisk } from './newsThemeRiskOverlay'
import { applyScreenerTechnicalOverlay } from './screenerTechnicalOverlay'
import { materializePostOverlayStrategySeed } from './screenerPostOverlaySeed'
import { annotateCandidatesWithStrategySpecs } from './screenerStrategyConsumer'
import { buildScoreV2Components } from './scoreV2Taxonomy'
import { materializeScreenerCoreSeeds, type ScreenerCoreSeedContext } from './screenerCoreSeedMaterializer'
import type { StrategySpec } from './strategySpec'

const identity = { signalDate: '2099-09-09', producerRunId: 'post-route-local-only',
  artifactCreatedAt: '2099-09-09T12:00:00Z', decisionDeadline: '2099-09-10T00:00:00Z' }
const spec: StrategySpec = { id: 'base', version: 'strategy-spec-v1', name: 'base', status: 'active', owner: 'strategy',
  ownerType: 'strategy', promotionStatus: 'production', familyId: 'TREND_RECLAIM_CONTINUATION', variantId: 'base',
  alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'local', thresholds: { minFactorSignals: { base: .5 } },
  candidatePolicy: { poolQuota: 10, costBudget: 10 }, riskNotes: [], createdBy: 'p5_strategy_governance' }
async function fixture() {
  const symbols = ['1000', '1001', '1002']
  const universe = symbols.map((symbol, i) => ({ symbol, name: symbol, sector: 'Semiconductor', industry: 'Semiconductor',
    score: 60, reason: 'base', chip_score: 20, tech_score: 18, momentum_score: 10,
    score_components: JSON.stringify(buildScoreV2Components({ mlEdge: 15, chipFlow: 15, technicalStructure: 15, fundamentalQuality: 15 })),
    current_price: 100, eligible_for_ml: 1, market_segment: 'LISTED',
    raw_signals: { close: 100, factorSignals: { base: i === 0 ? .9 : .1, next: i > 0 ? .9 : .1 } } }))
  const built = await buildLayer1WithAtomicSource({ ...identity, observedAt: '2020-01-01T00:00:00Z', universe,
    specs: [spec, { ...spec, id: 'new', variantId: 'new', status: 'candidate', promotionStatus: 'candidate',
      thresholds: { minFactorSignals: { next: .5 } } }],
    options: { targetSize: 10, coarseMlQueueSize: 10, regime: 'bull',
      strategyWeights: { base: 1, new: 1 }, productionStrategyWeights: { base: 1, new: 0 } } })
  const eligible = new Set(built.plan.breadthPool.map(row => row.symbol))
  const news = symbols.map(symbol => ({ symbol, sentiment: symbol === '1000' ? 'negative' : 'positive', cnt: 3 }))
  const riskRows = [
    { source_id: 'official_rss', title: 'negative risk warning', symbols_json: '["1000"]', source_quality_score: .9, entity_linking_confidence: .9 },
    { source_id: 'official_rss', title: 'trading_halt', symbols_json: '["1002"]', source_quality_score: .9, entity_linking_confidence: .9 },
  ]
  const foreign = Array.from({ length: 10 }, () => ({ total_foreign_net: -10 }))
  const history = symbols.flatMap(symbol => Array.from({ length: 20 }, (_, i) => ({ symbol, date: `2099-08-${String(i + 1).padStart(2, '0')}`,
    close: 100 + i, high: 101 + i, low: 99 + i, volume: 2_000_000 })))
  const flags = new Map(symbols.map(symbol => [symbol, { highFreq: symbol === '1000', newMoney: symbol !== '1000', freq20d: symbol === '1000' ? 15 : 0 }]))
  const recent = symbols.map(symbol => ({ symbol, days_count: 5 }))
  const theme = { combinedBuzz: [], symbolConceptTags: new Map<string, string[]>(), conceptBuzzScore: new Map<string, number>(),
    conceptCrowding: new Map<string, number>(), conceptEvidenceBreakdown: new Map<string, Record<string, number>>() }
  const capture = new ScreenerOverlayCapture()
  await capture.partitioned('news_sentiment', [...eligible], symbols, async scope => ({ rows: news.filter(row => scope.includes(row.symbol)), missing_identity_symbols: [] }))
  capture.record('theme_context', theme)
  await capture.partitioned('external_risk', [...eligible], symbols, async scope => ({ observations: [{ symbols: scope,
    rows: riskRows.filter(row => scope.some(symbol => row.symbols_json.includes(symbol))) }] }))
  capture.record('foreign_flow', { rows: foreign })
  await capture.partitioned('technical_history', [...eligible], symbols, async scope => history.filter(row => scope.includes(row.symbol)))
  await capture.partitioned('selection_history', [...eligible], symbols, async scope => new Map([...flags].filter(([symbol]) => scope.includes(symbol))))
  await capture.partitioned('recent_sessions', [...eligible], symbols, async scope => ({ rows: recent.filter(row => scope.includes(row.symbol)), missing_identity_symbols: [] }))
  // Exact sequence from actual formal call sites, before serialization.
  const scored = structuredClone(universe), excluded = new Set<string>()
  applyScreenerNewsSentiment(scored, eligible, news.filter(row => eligible.has(row.symbol)))
  applyScreenerBuzz(scored, eligible, { ...theme, hotConcepts: new Set() })
  applyScreenerExternalRisk(scored, eligible, materializeExternalEvidenceRisk([{ symbols: [...eligible], rows: riskRows }]), built.plan.coarseQueue, excluded)
  scored.sort((a, b) => b.score - a.score)
  applyScreenerForeignFlow(scored, foreign)
  applyScreenerTechnicalOverlay(scored, history, eligible)
  applyScreenerSelectionHistory(scored, new Map([...flags].filter(([symbol]) => eligible.has(symbol))), 6, 2)
  const finalSeed = annotateCandidatesWithStrategySpecs(materializePostOverlayStrategySeed(built.plan.coarseQueue, scored,
    built.source.inputs.specs, { regime: 'bull' }), built.source.inputs.specs)
  const ctx: ScreenerCoreSeedContext = { prices: new Map(symbols.map(symbol => [symbol, 100])), selectionFlags: flags,
    sectorBonus: new Map(), breezeWatchPoints: new Map(), chipMetadata: new Map(symbols.map(symbol => [symbol, null])),
    taxonomyPoints: new Map(symbols.map(symbol => [symbol, 'taxonomy:finlab'])),
    tpexSymbols: new Set(['1001']), allocationWeights: { base: .37, new: 0, other: .63 } }
  await capture.read('sector_bonus', symbols, async () => ({ schema_version: 'sector-bonus-frozen-inputs-v1',
    signal_date: identity.signalDate, corr_threshold: .7, bonus_points: 5, issues: [], source_status: 'captured',
    full_industry_universe: symbols.map(symbol => ({ symbol, sector: 'Semiconductor' })),
    inputs: { candidates: symbols.map(symbol => ({ symbol, sector: 'Semiconductor' })),
      leaderRows: [{ symbol: '1000', sector: 'Semiconductor' }], prices: symbols.flatMap(symbol => Array.from({ length: 65 }, (_, i) => ({
        symbol, date: new Date(Date.UTC(2099, 0, i + 1)).toISOString().slice(0, 10), close: 100 + i + Math.sin(i),
      }))) } }))
  capture.record('core_seed_context', { context: ctx })
  capture.record('core_seed_materialization', { owner: 'screener_pre_ml_seed_request', write_status: 'acknowledged', rows: materializeScreenerCoreSeeds(finalSeed, ctx) })
  const packet = capture.freeze({ signalDate: identity.signalDate, universeSymbols: symbols, formalSymbols: [...eligible],
    finalSeed, safetyExcludedSymbols: [...excluded], policy: { regime: 'bull', highFreqPenalty: 6, newMoneyBonus: 2,
      technicalRowsPerSymbol: 65, recentSessionsMaxExcluded: 2 } })
  return { built, packet, finalSeed }
}

test('canonical replay matches formal full overlay sequence and recomputes candidate own specs, veto and scores', async () => {
  const { built, packet, finalSeed } = await fixture()
  assert.deepEqual(finalSeed.map(row => [row.symbol, row.score]), [['1000', 45]])
  const source = await sealAtomicPostOverlaySource(built.source, packet), before = structuredClone(source)
  const replay = await replayAtomicStrategySource(source, source.replacements[0], identity)
  assert.equal(replay.post_overlay_replay.status, 'baseline_matched_candidate_replayed')
  if (replay.post_overlay_replay.status !== 'baseline_matched_candidate_replayed') throw new Error('missing test replay')
  const { baseline, candidate } = replay.post_overlay_replay
  if (baseline.status !== 'replayed' || candidate.status !== 'replayed') throw new Error('missing test arms')
  assert.deepEqual(baseline.finalSeed, finalSeed)
  assert.deepEqual(candidate.finalSeed.map(row => [row.symbol, row.score]), [['1001', 64]])
  assert.deepEqual(candidate.safetyExcludedSymbols, ['1002'])
  assert(candidate.finalSeed[0].strategy_pool_ids!.includes('new'))
  assert(!candidate.finalSeed[0].strategy_pool_ids!.includes('base'))
  assert.equal(replay.core_seed_replay.status, 'matched')
  assert.equal(replay.candidate_core_replay.status, 'materialized')
  if (replay.candidate_core_replay.status !== 'materialized') throw new Error('missing candidate Core')
  assert.deepEqual(replay.candidate_core_replay.allocation_weights, { base: 0, new: .37, other: .63 })
  assert.equal(replay.candidate_core_replay.rows[0].seed.row.seedScore, 53, 'candidate gets its own peer correlation bonus; formal Core had none')
  assert.equal(replay.candidate_core_replay.rows[0].eligibleForPendingBuy, true)
  assert.equal(replay.candidate_core_replay.rows[0].marketSegment, 'OTC')
  assert(replay.candidate_core_replay.rows[0].watchPoints.some(point => point.includes('freq20d=0,high_freq=no,new_money=yes')))
  assert.equal(replay.promotion_allowed, false)
  assert.equal(replay.nav_maturity_credit, 0)
  assert.deepEqual(source, before)
  assert.deepEqual(await replayAtomicStrategySource(source, source.replacements[0], identity), replay)
})

test('candidate-only missing observation cannot borrow formal values or erase a covered baseline', async () => {
  const { built, packet } = await fixture()
  packet.observations.news_sentiment[1].status = 'failed'
  const baseline = replayFrozenPostRoute({ packet, universe: built.source.inputs.universe, plan: built.plan, specs: built.source.inputs.specs })
  assert.equal(baseline.status, 'replayed')
  const source = await sealAtomicPostOverlaySource(built.source, packet)
  const replay = await replayAtomicStrategySource(source, source.replacements[0], identity)
  assert.deepEqual(replay.post_overlay_replay, { status: 'unavailable', reason: 'news_sentiment:unverified' })
  assert.equal(replay.core_seed_replay.status, 'matched')
})

test('relevant frozen source failures, future prices, missing risk coverage and validly sealed output mismatch reject', async () => {
  const { built, packet } = await fixture()
  const cases: Array<[RegExp, (value: typeof packet) => void]> = [
    [/post_overlay_replay_mismatch/, value => { (value.finalSeed as any[])[0].score++ }],
    [/raw_value_invalid/, value => { (value.observations.technical_history[0].value as any[])[0].date = '2100-01-01' }],
    [/risk_source_coverage_invalid/, value => { (value.observations.external_risk[0].value as any).observations = [] }],
    [/selection_source_invalid/, value => { (value.observations.selection_history[0].value as any).entries = [] }],
    [/observation_overlap/, value => { value.observations.news_sentiment.push(structuredClone(value.observations.news_sentiment[0])) }],
  ]
  for (const [expected, mutate] of cases) {
    const changed = structuredClone(packet)
    mutate(changed)
    const source = await sealAtomicPostOverlaySource(built.source, changed)
    await assert.rejects(replayAtomicStrategySource(source, source.replacements[0], identity), expected)
  }
})

test('positive news cannot invent alpha; missing ScoreV2 retains original no-adjustment behavior', () => {
  const row = { symbol: '1000', score: 60, reason: 'base', score_components: JSON.stringify(buildScoreV2Components({ chipFlow: 20 })) }
  assert.equal(applyScoreV2NewsThemeAdjustment(row, 5, 'positive'), 0)
  assert.equal(row.score, 60)
  assert.equal(applyScoreV2NewsThemeAdjustment({ score: 60 }, -8, 'negative'), 0)
  assert.equal(applyScoreV2NewsThemeAdjustment(row, -8, 'risk', ['flag']), -8)
  assert.equal(row.score, 52)
})

test('candidate recent-session safety can legitimately leave no picks; never top up from the formal slate', async () => {
  const { built, packet } = await fixture()
  const rows = (packet.observations.recent_sessions[1].value as any).rows
  rows.find((row: any) => row.symbol === '1001').days_count = 2
  const source = await sealAtomicPostOverlaySource(built.source, packet)
  const result = await replayAtomicStrategySource(source, source.replacements[0], identity)
  assert.equal(result.post_overlay_replay.status, 'baseline_matched_candidate_replayed')
  if (result.post_overlay_replay.status !== 'baseline_matched_candidate_replayed') throw new Error('test missing')
  const candidate = result.post_overlay_replay.candidate
  if (candidate.status !== 'replayed') throw new Error('test missing candidate')
  assert.deepEqual(candidate.finalSeed, [])
  assert.deepEqual([...candidate.safetyExcludedSymbols].sort(), ['1001', '1002'])
  const empty = replayFrozenPostRoute({ packet: { ...packet, observations: {} }, universe: [],
    plan: { breadthPool: [], coarseQueue: [] }, specs: built.source.inputs.specs })
  assert.equal(empty.status, 'replayed', 'explicit zero admission is not missing source or manufactured performance')
  if (empty.status === 'replayed') assert.deepEqual(empty.finalSeed, [])
})
