import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { RestEvidenceArtifactWriter } from '../node-runner/cloudflareRestBindings'
import { buildLayer1WithAtomicSource, sealAtomicPostOverlaySource, buildAtomicStrategyShadow } from './atomicStrategyShadow'
import { ScreenerOverlayCapture } from './screenerOverlayCapture'
import { materializeScreenerCoreSeeds, type ScreenerCoreSeedContext } from './screenerCoreSeedMaterializer'
import { materializePostOverlayStrategySeed } from './screenerPostOverlaySeed'
import { annotateCandidatesWithStrategySpecs } from './screenerStrategyConsumer'
import { replayCanonicalAtomicSource, replayCanonicalAtomicPopulation } from './atomicStrategySource'
import { sha256Text } from './datasetSnapshots'
import type { StrategySpec } from './strategySpec'
import type { EvidenceArtifactWriteInput } from './evidenceArtifactContract'
import { buildStrategyAdaptivePolicyState, evaluateStrategyPromotionGate, type StrategyLearningSummary } from './strategyLearning'
import { buildStrategyEvidenceOwnerSnapshot } from './strategyEvidenceOwnerFusion'
import { listStrategyEvidenceProfiles } from './strategyEvidenceProfile'
import { buildStrategyProductionPolicyState } from './strategyProductionPolicyService'
import { captureStrategyWeightSource } from './strategyProductionWeightReplay'

async function originalWeightSource(strategies: StrategySpec[]) {
  const day = '2026-09-08'
  const summary = { date: day, specs: strategies.map(spec => ({ ...spec, learning: {
    rolling_samples: 45, rolling_reward_dates: 12, rolling_evaluable_decisions: 80, decisions: 800,
  } })), promotion_gate: [], replacement_gate: { decisions: [], candidate_prefilters: [], evidence_status: 'pending' },
  } as unknown as StrategyLearningSummary
  summary.promotion_gate = evaluateStrategyPromotionGate(summary)
  const evidenceFusion = await buildStrategyEvidenceOwnerSnapshot({ strategies, knowledgeCutoffDate: day,
    rows: listStrategyEvidenceProfiles(strategies).flatMap(profile => profile.required_metrics.map(metric => ({
      strategy_id: profile.strategy_id, strategy_version: profile.strategy_version,
      primary_horizon_days: profile.primary_horizon_days, metric_name: metric, metric_value: .01,
      metric_status: 'ready', sample_count: 45, mature_dates: 12,
      outcome_as_of_date: '2026-09-07', definition_version: 'strategy-evidence-metrics-v4',
    }))) })
  const input = { knowledgeCutoffDate: day, strategies, gates: summary.promotion_gate, evidenceFusion,
    adaptiveState: buildStrategyAdaptivePolicyState(summary, { nowIso: day + 'T12:00:00Z' }) }
  return captureStrategyWeightSource(input, buildStrategyProductionPolicyState(input))
}

test('actual REST writer -> local D1/R2 canonical source -> full-universe Atomic replay, direct and chunked', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }',
    d1Databases: ['NAV'], r2Buckets: ['EVIDENCE'] })
  const oldFetch = globalThis.fetch
  try {
    const db = await mf.getD1Database('NAV')
    // Miniflare's ReplaceWorkersTypes resolves the ambient R2 type incorrectly
    // alongside Workers and DOM declarations; the live binding is tested here.
    const r2 = await mf.getR2Bucket('EVIDENCE') as unknown as {
      get(key: string): Promise<{ text(): Promise<string> } | null>
      put(key: string, body: string): Promise<unknown>
    }
    await db.prepare(`CREATE TABLE run_artifacts (artifact_id TEXT PRIMARY KEY,retention_class TEXT,status TEXT,
      domain TEXT,business_date TEXT,producer_run_id TEXT,canonical_run_id TEXT,r2_key TEXT,checksum TEXT,schema_version TEXT,
      row_count INTEGER,byte_size INTEGER,created_at TEXT,retain_until TEXT,pinned INTEGER,legal_hold INTEGER,
      hard_ref_count INTEGER,checksum_verified_at TEXT,metadata_json TEXT,updated_at TEXT,payload_deleted_at TEXT)`).run()
    await db.prepare(`CREATE TABLE pipeline_runs (run_id TEXT PRIMARY KEY,business_date TEXT,domain TEXT,status TEXT,
      canonical_at TEXT,artifact_id TEXT)`).run()
    const env = { DB: db, ARTIFACTS: r2, STOCKVISION_AUTH_TOKEN: 'isolated-test-token' } as any
    const requests: EvidenceArtifactWriteInput[] = []
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://local.test/api/internal/evidence-artifacts/screener-funnel')
      const value = JSON.parse(String(init?.body))
      requests.push(value)
      assert(Buffer.byteLength(String(init?.body)) <= 2 * 1024 * 1024, 'every request, including index, obeys existing limit')
      return adminControlRoutes.request(String(url), init, env)
    }
    const writer = new RestEvidenceArtifactWriter({ workerUrl: 'https://local.test', serviceToken: 'isolated-test-token', maxRetries: 0 })
    const spec: StrategySpec = { id: 'base', version: 'strategy-spec-v1', name: 'base', status: 'active', owner: 'strategy',
      ownerType: 'strategy', promotionStatus: 'production', familyId: 'TREND_RECLAIM_CONTINUATION', variantId: 'base',
      alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'test',
      thresholds: { minFactorSignals: { base: .5 } }, candidatePolicy: { poolQuota: 10, costBudget: 10 },
      riskNotes: [], createdBy: 'p5_strategy_governance' }
    for (const [count, zeroWeight, weightOwner] of [[3, false, false], [3, true, false], [830, false, false], [3, false, true]] as const) {
      const runId = `source-${count}${zeroWeight ? '-zero' : ''}${weightOwner ? '-daily-owner' : ''}`
      let capture = await buildLayer1WithAtomicSource({ signalDate: '2026-09-09', producerRunId: runId,
        observedAt: '2026-09-09T12:00:00Z', specs: [spec, { ...spec, id: 'new', variantId: 'new',
          status: 'candidate', promotionStatus: 'candidate', thresholds: { minFactorSignals: { next: .5 } } }],
        options: { targetSize: 10, coarseMlQueueSize: 10, regime: 'bull',
          strategyWeights: { base: 1, new: zeroWeight ? 0 : 1 }, productionStrategyWeights: { base: 1, new: 0 } },
        universe: Array.from({ length: count }, (_, i) => ({ symbol: String(1000 + i), eligible_for_ml: 1,
          sector: i < 2 ? 'Semiconductor' : 'Unrelated', industry: i < 2 ? 'Semiconductor' : 'Unrelated',
          score: 60, reason: 'local fixture', chip_score: 20, tech_score: 18, momentum_score: 10,
          market_segment: 'LISTED', current_price: 50,
          raw_signals: { close: 50, factorSignals: { base: i === 0 ? .9 : .1, next: i === 1 ? .9 : .1 } },
          source_note: count > 3 ? '完整來源🧪'.repeat(180) : '' })) })
      if (weightOwner) capture = await buildLayer1WithAtomicSource({ ...capture.source.inputs,
        productionWeightSource: await originalWeightSource(capture.source.inputs.specs),
        options: { ...capture.source.inputs.options, performanceWeightOwner: 'ple_portfolio_metrics' } })
      const overlayCapture = new ScreenerOverlayCapture()
      const formalSymbols = capture.plan.breadthPool.map(row => row.symbol)
      const allSymbols = capture.source.expected_universe_symbols
      await overlayCapture.partitioned('news_sentiment', formalSymbols, allSymbols, async () => ({ rows: [], missing_identity_symbols: [] }))
      overlayCapture.record('theme_context', { combinedBuzz: [], symbolConceptTags: new Map(), conceptBuzzScore: new Map(),
        conceptCrowding: new Map(), conceptEvidenceBreakdown: new Map() })
      await overlayCapture.partitioned('external_risk', formalSymbols, allSymbols, async symbols => ({ observations: [{ symbols, rows: [] }] }))
      overlayCapture.record('foreign_flow', { rows: [] })
      await overlayCapture.partitioned('technical_history', formalSymbols, allSymbols, async () => [])
      await overlayCapture.partitioned('selection_history', formalSymbols, allSymbols, async symbols => new Map(
        symbols.map(symbol => [symbol, { highFreq: false, newMoney: false, freq20d: 1 }])))
      await overlayCapture.partitioned('recent_sessions', formalSymbols, allSymbols, async symbols => ({
        rows: symbols.map(symbol => ({ symbol, days_count: 5 })), missing_identity_symbols: [] }))
      // Same formal post-route materializer/annotation; all synthetic overlays
      // are explicitly empty/no-op here. Numerical effects tested separately.
      const finalSeed = annotateCandidatesWithStrategySpecs(materializePostOverlayStrategySeed(capture.plan.coarseQueue,
        capture.source.inputs.universe, capture.source.inputs.specs, { regime: 'bull' }), capture.source.inputs.specs)
      const coreContext: ScreenerCoreSeedContext = { prices: new Map([['1000', 50], ['1001', 75]]), selectionFlags: new Map(),
        sectorBonus: new Map([['1000', { bonus: 5, avgCorr: .9 }]]), breezeWatchPoints: new Map(),
        chipMetadata: new Map([['1000', null], ['1001', null]]), taxonomyPoints: new Map([['1000', null], ['1001', null]]),
        tpexSymbols: new Set(['1001']), allocationWeights: { base: .41, new: 0, other: .59 } }
      await overlayCapture.read('sector_bonus', ['1000', '1001'], async () => ({
        schema_version: 'sector-bonus-frozen-inputs-v1', signal_date: '2026-09-09', corr_threshold: .7, bonus_points: 5,
        issues: [], source_status: 'captured',
        full_industry_universe: capture.source.inputs.universe.map(row => ({ symbol: row.symbol, sector: row.sector })),
        inputs: { candidates: ['1000', '1001'].map(symbol => ({ symbol, sector: 'Semiconductor' })),
          leaderRows: [{ symbol: '1000', sector: 'Semiconductor' }],
          prices: ['1000', '1001'].flatMap(symbol => Array.from({ length: 65 }, (_, i) => ({ symbol,
            date: new Date(Date.UTC(2026, 5, i + 1)).toISOString().slice(0, 10), close: 100 + i + Math.sin(i) }))) } }))
      overlayCapture.record('core_seed_context', { context: coreContext })
      overlayCapture.record('core_seed_materialization', { owner: 'screener_pre_ml_seed_request', write_status: 'acknowledged',
        rows: materializeScreenerCoreSeeds(finalSeed, coreContext) })
      const overlayPacket = overlayCapture.freeze({ signalDate: '2026-09-09',
        universeSymbols: capture.source.expected_universe_symbols, formalSymbols: capture.plan.breadthPool.map(row => row.symbol),
        finalSeed, safetyExcludedSymbols: [], policy: { regime: 'bull', highFreqPenalty: 6, newMoneyBonus: 2,
          technicalRowsPerSymbol: 65, recentSessionsMaxExcluded: 2 } })
      // Local synthetic replay; raw theme-feed/sector-source completeness is
      // still not attested, so this cannot grant NAV maturity or promotion.
      for (const records of Object.values(overlayPacket.observations)) for (const record of records) {
        record.started_at = record.completed_at = '2026-09-09T12:00:20.000Z'
      }
      overlayPacket.completed_at = '2026-09-09T12:00:30.000Z'
      const sealedSource = await sealAtomicPostOverlaySource(capture.source, overlayPacket)
      const scoringItems = allSymbols.map(symbol => ({ symbol, stage: 'scoring', decision: 'pass',
        scoreAfter: 41, evidence: { score_components: { originalScoring: 41 },
          sourceNote: count > 3 ? 'x'.repeat(2100) : '' } }))
      const seedItems = finalSeed.map((row, index) => ({ symbol: row.symbol,
        stage: 'l1_candidate_seed_after_overlay', decision: 'selected', rank: index + 1,
        scoreAfter: row.score, evidence: { strategy_pool_reason: 'original fixture route' } }))
      const originalItems = [...scoringItems, ...seedItems,
        { symbol: '1000', stage: 'final_selection', decision: 'observe', evidence: {} }]
      const input: EvidenceArtifactWriteInput = { domain: 'screener_funnel', businessDate: '2026-09-09', producerRunId: runId,
        createdAt: '2026-09-09T12:01:00.100Z', retentionClass: 'canonical_model_evidence',
        schemaVersion: 'screener-funnel-evidence-v3', rowCount: originalItems.length,
        payload: { metadata: { status: 'success' }, items: originalItems,
          atomic_strategy_source: sealedSource } }
      const inputBefore = structuredClone(input)
      const manifest = await writer.write(input)
      assert.equal((await writer.write(input)).artifact_id, manifest.artifact_id, 'same sealed retry retains parent content identity')
      assert.deepEqual(input, inputBefore, 'transport cannot mutate source or fingerprint input')
      assert.equal(manifest.schema_version, count === 3 ? 'screener-funnel-evidence-v3' : 'screener-funnel-evidence-index-v1')
      await db.prepare('INSERT INTO pipeline_runs VALUES (?,?,?,?,?,?)').bind(runId, '2026-09-09', 'screener', 'canonical',
        '2026-09-09 12:01:00', manifest.artifact_id).run()
      if (zeroWeight) {
        const replacement = { candidateId: 'new', candidateVersion: spec.version, incumbentId: 'base', incumbentVersion: spec.version }
        const admitted = await buildAtomicStrategyShadow({ ...capture.source.inputs,
          expectedUniverseSymbols: capture.source.expected_universe_symbols, replacement,
          options: { ...capture.source.inputs.options, strategyWeights: { base: 1, new: 1 } } })
        const request = { signalDate: '2026-09-09', producerRunId: runId, decisionDeadline: '2026-09-09T23:15:00Z' }
        const ordinary = await replayCanonicalAtomicPopulation(env, request)
        assert.deepEqual(ordinary.replacements, [], 'zero-weight candidate is not a new admission')
        const continuations = [{ replacement, definitionChecksum: admitted.replacement_definition_checksum,
          executionSnapshotIds: ['a'.repeat(64)] }]
        const before = await db.prepare('SELECT * FROM run_artifacts ORDER BY artifact_id').all()
        const response = await adminControlRoutes.request('https://local.test/api/internal/evidence-artifacts/atomic-population', {
          method: 'POST', headers: { Authorization: 'Bearer isolated-test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, continuations }),
        }, env)
        assert.equal(response.status, 200)
        const continued = await response.json() as any
        assert.deepEqual(continued.continuations, continuations)
        assert.deepEqual(continued.baseline, ordinary.baseline)
        assert.equal(continued.replacements.length, 1)
        assert.equal(continued.replacements[0].definition_checksum, admitted.replacement_definition_checksum)
        assert.equal(continued.policy_context.policy.options.strategyWeights.new, 0)
        assert.equal(continued.replacements[0].candidate.status, 'materialized')
        assert.equal(continued.replacements[0].recommendation_seed.status, 'replayed')
        assert.equal(continued.nav_maturity_credit, 0)
        assert.deepEqual((await db.prepare('SELECT * FROM run_artifacts ORDER BY artifact_id').all()).results, before.results)
        await assert.rejects(replayCanonicalAtomicPopulation(env, { ...request,
          continuations: [{ ...continuations[0], definitionChecksum: 'b'.repeat(64) }] }), /continuation_definition_changed/)
        for (const malformed of [null, {}, [{ ...continuations[0], definitionChecksum: [continuations[0].definitionChecksum] }],
          [{ ...continuations[0], executionSnapshotIds: [] }], [continuations[0], continuations[0]]]) {
          const rejected = await adminControlRoutes.request('https://local.test/api/internal/evidence-artifacts/atomic-population', {
            method: 'POST', headers: { Authorization: 'Bearer isolated-test-token', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...request, continuations: malformed }),
          }, env)
          assert.equal(rejected.status, 400)
        }
        continue
      }
      const request = { signalDate: '2026-09-09', producerRunId: runId,
        decisionDeadline: '2026-09-09T23:15:00Z', replacement: capture.source.replacements[0] }
      const before = await db.prepare('SELECT * FROM run_artifacts ORDER BY artifact_id').all()
      const result = await replayCanonicalAtomicSource(env, request)
      const populationRequest = { signalDate: request.signalDate, producerRunId: runId, decisionDeadline: request.decisionDeadline }
      if (weightOwner) {
        const legacy = await buildAtomicStrategyShadow({ ...capture.source.inputs, productionWeightSource: undefined,
          expectedUniverseSymbols: capture.source.expected_universe_symbols, replacement: request.replacement })
        assert.notEqual(legacy.replacement_definition_checksum, result.replacement_definition_checksum)
        const continuations = [legacy, result].map((item, index) => ({ replacement: request.replacement,
          definitionChecksum: item.replacement_definition_checksum, executionSnapshotIds: [String(index + 1).repeat(64)] }))
        const mixed = await replayCanonicalAtomicPopulation(env, { ...populationRequest, continuations })
        assert.equal(mixed.replacements.length, 2, 'one role pair retains both distinct original policies')
        assert.deepEqual(new Set(mixed.replacements.map(r => r.definition_checksum)),
          new Set(continuations.map(r => r.definitionChecksum)))
        assert.equal(mixed.replacements.filter(r => r.weight_policy_version === 'strategy-original-daily-weight-owner-v1').length, 1)
        assert.equal(mixed.replacements.filter(r => r.weight_policy_version == null).length, 1)
        assert.equal(mixed.nav_maturity_credit, 0)
      }
      const endpoint = 'https://local.test/api/internal/evidence-artifacts/atomic-population'
      assert.equal((await adminControlRoutes.request(endpoint, { method: 'POST', body: JSON.stringify(populationRequest) }, env)).status, 401)
      const populationResponse = await adminControlRoutes.request(endpoint, { method: 'POST',
        headers: { Authorization: 'Bearer isolated-test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(populationRequest) }, env)
      assert.equal(populationResponse.status, 200)
      const population = await populationResponse.json() as any
      assert.equal(population.schema_version, 'atomic-canonical-population-v1')
      assert.equal(population.source_checksum, result.source_checksum)
      assert.deepEqual(population.baseline, result.core_seed_replay)
      assert.deepEqual(population.replacements.map((r: any) => r.replacement), sealedSource.replacements)
      assert.deepEqual(population.replacements[0].candidate, result.candidate_core_replay)
      assert.deepEqual(population.screener_seed_source.items, [...scoringItems, ...seedItems])
      assert.equal(population.screener_seed_source.source_item_count, originalItems.length)
      assert.equal(population.screener_seed_source.items[0].evidence.score_components.originalScoring, 41,
        'original OPS scoring is not reconstructed from calibrated Core seedScore=53')
      assert.equal(population.replacements[0].recommendation_seed.status, 'replayed')
      assert.deepEqual(population.replacements[0].recommendation_seed.final_seed.map((r: any) => r.symbol), ['1001'])
      assert.deepEqual(population.replacements[0].recommendation_seed.coarse_queue, result.candidate.coarseQueue)
      const mergeItem = population.replacements[0].recommendation_seed.merge_items[0]
      assert.equal(mergeItem.symbol, '1001')
      assert.equal(mergeItem.stage, 'l1_candidate_seed_after_overlay')
      assert.equal(mergeItem.rank, 1)
      assert.deepEqual(population.replacements[0].core_upsert_bindings[0].slice(0, 3), ['2026-09-09', '1001', '1001'])
      assert.equal(population.replacements[0].definition_checksum, result.replacement_definition_checksum)
      assert.deepEqual(population.policy_context.policy, result.baseline_policy)
      assert.equal(population.policy_context.source_checksum, sealedSource.source_checksum)
      assert.equal(population.production_effect, false)
      assert.equal(population.nav_maturity_credit, 0)
      assert.equal((await adminControlRoutes.request(endpoint, { method: 'POST',
        headers: { Authorization: 'Bearer isolated-test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...populationRequest, replacement: request.replacement }) }, env)).status, 400,
      'caller cannot cherry-pick the structural population')
      assert.equal(result.source_universe_count, count)
      assert.equal(result.source_checksum, sealedSource.source_checksum)
      assert.deepEqual(result.post_overlay, overlayPacket, 'all nested data survive actual direct/chunked canonical transport')
      assert.equal(result.post_overlay?.input_status, 'incomplete', 'transport is not replay/effect approval')
      assert.equal(result.core_seed_replay.status, 'matched', 'actual canonical D1/R2 reader reconciles the Core request')
      if (result.core_seed_replay.status !== 'matched') throw new Error('test core replay missing')
      assert.equal(result.core_seed_replay.rows[0].seed.row.seedScore, 53)
      assert.equal(result.core_seed_replay.rows[0].eligibleForPendingBuy, true)
      assert.equal(result.post_overlay_replay.status, 'baseline_matched_candidate_replayed')
      assert.equal(result.candidate_core_replay.status, 'materialized', 'candidate Core executes after the actual canonical D1/R2 read')
      if (result.candidate_core_replay.status !== 'materialized') throw new Error('candidate Core missing')
      assert.deepEqual(result.candidate_core_replay.allocation_weights, { base: 0, new: .41, other: .59 })
      assert.equal(result.candidate_core_replay.rows[0].seed.row.currentPrice, 75)
      assert.equal(result.candidate_core_replay.rows[0].seed.row.seedScore, 53)
      assert.equal(result.candidate_core_replay.rows[0].eligibleForPendingBuy, true)
      assert.equal(result.candidate_core_replay.rows[0].marketSegment, 'OTC')
      assert.deepEqual(result.baseline_symbols, ['1000'])
      assert.deepEqual(result.candidate_symbols, ['1001'])
      assert.equal(result.nav_maturity_credit, 0)
      assert.equal(result.promotion_allowed, false)
      assert.deepEqual((await db.prepare('SELECT * FROM run_artifacts ORDER BY artifact_id').all()).results, before.results)
      await assert.rejects(replayCanonicalAtomicSource(env, { ...request, producerRunId: 'missing' }), /canonical_run_missing/)
      await assert.rejects(replayCanonicalAtomicSource(env, { ...request, decisionDeadline: '2026-09-09T12:01:00.500Z' }), /canonical_time_invalid/)
      await db.prepare("UPDATE pipeline_runs SET status='superseded' WHERE run_id=?").bind(runId).run()
      assert.equal((await replayCanonicalAtomicSource(env, request)).source_checksum, result.source_checksum,
        'an explicitly pinned once-canonical run is not replaced by latest')
      if (count > 3) {
        const raw = await (await r2.get(manifest.r2_key))!.text()
        const parent = JSON.parse(raw)
        const pointer = parent.payload.payload_header.atomic_strategy_source
        assert(parent.payload.chunks.length > 1, 'test real multi-chunk funnel coverage independently of source fragments')
        for (const fault of ['missing', 'duplicate', 'reordered', 'count', 'gap']) {
          const changed = structuredClone(parent)
          const refs = changed.payload.chunks
          if (fault === 'missing') refs.pop()
          if (fault === 'duplicate') refs[1] = refs[0]
          if (fault === 'reordered') refs.reverse()
          if (fault === 'count') changed.payload.item_count++
          if (fault === 'gap') refs[1].row_start++
          const corrupt = JSON.stringify(changed)
          await r2.put(manifest.r2_key, corrupt)
          await db.prepare('UPDATE run_artifacts SET checksum=? WHERE artifact_id=?')
            .bind(await sha256Text(corrupt), manifest.artifact_id).run()
          await assert.rejects(replayCanonicalAtomicPopulation(env, populationRequest), /atomic_funnel_/)
        }
        await r2.put(manifest.r2_key, raw)
        await db.prepare('UPDATE run_artifacts SET checksum=? WHERE artifact_id=?').bind(manifest.checksum, manifest.artifact_id).run()
        const funnelRef = parent.payload.chunks[0]
        const funnelRaw = await (await r2.get(funnelRef.r2_key))!.text()
        await r2.put(funnelRef.r2_key, funnelRaw + ' ')
        await assert.rejects(replayCanonicalAtomicPopulation(env, populationRequest), /artifact_checksum_mismatch/)
        await r2.put(funnelRef.r2_key, funnelRaw)
        assert.equal(pointer.schema_version, 'atomic-strategy-source-chunks-v1')
        assert(pointer.fragments.length > 1)
        for (const fault of ['missing', 'duplicate', 'reordered', 'other-run']) {
          const changed = structuredClone(parent)
          const refs = changed.payload.payload_header.atomic_strategy_source.fragments
          if (fault === 'missing') refs.pop()
          if (fault === 'duplicate') refs[1] = refs[0]
          if (fault === 'reordered') refs.reverse()
          if (fault === 'other-run') refs[0].producer_run_id = 'other-run'
          const corrupt = JSON.stringify(changed)
          await r2.put(manifest.r2_key, corrupt)
          await db.prepare('UPDATE run_artifacts SET checksum=? WHERE artifact_id=?')
            .bind(await sha256Text(corrupt), manifest.artifact_id).run()
          await assert.rejects(replayCanonicalAtomicSource(env, request), /atomic_source_fragment_/)
        }
        await r2.put(manifest.r2_key, raw)
        await db.prepare('UPDATE run_artifacts SET checksum=? WHERE artifact_id=?').bind(manifest.checksum, manifest.artifact_id).run()
        const fragment = pointer.fragments[0]
        const fragmentRaw = await (await r2.get(fragment.r2_key))!.text()
        await r2.put(fragment.r2_key, fragmentRaw + ' ')
        await assert.rejects(replayCanonicalAtomicSource(env, request), /artifact_checksum_mismatch/)
        await r2.put(fragment.r2_key, fragmentRaw)
        assert.equal((await replayCanonicalAtomicSource(env, request)).source_checksum, result.source_checksum)
        const noItems = await writer.write({ ...input, rowCount: 0, payload: { ...input.payload, items: [] } })
        await db.prepare('UPDATE pipeline_runs SET artifact_id=? WHERE run_id=?').bind(noItems.artifact_id, runId).run()
        assert.equal((await replayCanonicalAtomicSource(env, request)).source_checksum, result.source_checksum,
          'zero item coverage does not omit or invent source-universe rows')
        const emptyItems = await replayCanonicalAtomicPopulation(env, populationRequest)
        assert.deepEqual(emptyItems.screener_seed_source.items, [])
        assert.equal(emptyItems.screener_seed_source.source_item_count, 0)
        console.log(JSON.stringify({ universe: count, sourceBytes: pointer.byte_size, sourceFragments: pointer.fragments.length,
          maxRequestBytes: Math.max(...requests.map(r => Buffer.byteLength(JSON.stringify(r)))), added: result.added_symbols.length,
          removed: result.removed_symbols.length, maturityCredit: result.nav_maturity_credit }))
      }
    }
  } finally {
    globalThis.fetch = oldFetch
    await mf.dispose()
  }
})
