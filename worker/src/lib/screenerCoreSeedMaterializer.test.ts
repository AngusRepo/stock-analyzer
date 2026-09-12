import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { buildLayer1WithAtomicSource, replayAtomicStrategySource, sealAtomicPostOverlaySource } from './atomicStrategyShadow'
import { ScreenerOverlayCapture } from './screenerOverlayCapture'
import { decodeScreenerCoreSeedContext, materializeScreenerCoreSeeds, type ScreenerCoreSeedContext } from './screenerCoreSeedMaterializer'
import type { StrategySpec } from './strategySpec'

const identity = { signalDate: '2099-09-09', producerRunId: 'core-seed-local-test',
  artifactCreatedAt: '2099-09-09T12:00:00Z', decisionDeadline: '2099-09-10T00:00:00Z' }
const spec: StrategySpec = { id: 'base', version: 'strategy-spec-v1', name: 'base', status: 'active', owner: 'strategy',
  ownerType: 'strategy', promotionStatus: 'production', familyId: 'TREND_RECLAIM_CONTINUATION', variantId: 'base',
  alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'local test', thresholds: { minFactorSignals: { base: .5 } },
  candidatePolicy: { poolQuota: 10, costBudget: 10 }, riskNotes: [], createdBy: 'p5_strategy_governance' }
const candidates = ['2330', '2317'].map(symbol => ({ symbol, name: symbol, sector: 'Semiconductor', industry: 'Semiconductor',
  score: 99, chip_score: 20, tech_score: 18, momentum_score: 10,
  score_components: { z: 2, a: { z: 3, a: 4 } }, strategy_tags: ['frozen'], strategy_pool_ids: [symbol === '2330' ? 'base' : 'new'],
  strategy_watch_points: ['frozen', 'frozen'] }))
function context(): ScreenerCoreSeedContext {
  return { prices: new Map([['2330', 100], ['2317', 50]]),
    selectionFlags: new Map([['2330', { highFreq: true, newMoney: false, freq20d: 3 }]]),
    sectorBonus: new Map([['2330', { bonus: 5, avgCorr: .9 }]]),
    breezeWatchPoints: new Map([['2330', 'breeze:captured']]), chipMetadata: new Map([['2330', 'chip:captured']]),
    taxonomyPoints: new Map([['2330', 'taxonomy:finlab']]), tpexSymbols: new Set(['2317']), allocationWeights: { base: 1, new: 0 } }
}
function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Map ? { entries: [...item] } : item instanceof Set ? [...item] : item))
}
async function fixture(empty = false) {
  const selected = empty ? [] : candidates
  const built = await buildLayer1WithAtomicSource({ signalDate: identity.signalDate, producerRunId: identity.producerRunId,
    observedAt: '2020-01-01T00:00:00Z', specs: [spec, { ...spec, id: 'new', variantId: 'new', status: 'candidate', promotionStatus: 'candidate' }],
    options: { targetSize: 10, coarseMlQueueSize: 10, regime: 'bull', strategyWeights: { base: 1, new: 1 }, productionStrategyWeights: { base: 1, new: 0 } },
    universe: selected.map(row => ({ ...row, current_price: 50, eligible_for_ml: 1, market_segment: 'LISTED',
      raw_signals: { close: 50, factorSignals: { base: .9 } } })) })
  const capture = new ScreenerOverlayCapture(), ctx = context()
  capture.record('core_seed_context', { context: ctx })
  capture.record('core_seed_materialization', { owner: 'screener_pre_ml_seed_request', write_status: 'acknowledged',
    rows: materializeScreenerCoreSeeds(selected, ctx) })
  const packet = capture.freeze({ signalDate: identity.signalDate, universeSymbols: selected.map(row => row.symbol),
    formalSymbols: built.plan.breadthPool.map(row => row.symbol), finalSeed: selected, safetyExcludedSymbols: [], policy: {} })
  return { built, packet, ctx }
}

test('actual shared materializer preserves score components, rank, metadata and own allocation eligibility', () => {
  const ctx = context(), before = snapshot(ctx), original = structuredClone(candidates)
  const rows = materializeScreenerCoreSeeds(candidates, ctx)
  assert.deepEqual(rows.map(row => row.seed.row.seedScore), [53, 48], '99 overlay score is not the legacy Core formula')
  assert.deepEqual(rows.map(row => row.seed.rank), [1, 2])
  assert.deepEqual(rows.map(row => row.eligibleForPendingBuy), [true, false])
  assert.deepEqual(rows.map(row => row.marketSegment), ['LISTED', 'OTC'])
  assert(rows[0].watchPoints.includes('breeze:captured'))
  assert.equal(rows[0].watchPoints.filter(value => value === 'frozen').length, 1)
  ctx.allocationWeights = { base: 0, new: 1 }
  assert.deepEqual(materializeScreenerCoreSeeds([...candidates].reverse(), ctx).map(row => row.eligibleForPendingBuy), [true, false])
  ctx.allocationWeights = before.allocationWeights
  assert.deepEqual(snapshot(ctx), before)
  assert.deepEqual(candidates, original)
  assert.deepEqual(materializeScreenerCoreSeeds([], ctx), [])
})

test('existing canonical replay reconciles acknowledged seeds despite JSON key order, without claiming full execution', async () => {
  const { built, packet, ctx } = await fixture()
  const source = await sealAtomicPostOverlaySource(built.source, packet)
  const before = structuredClone(source)
  ctx.prices.set('2330', 999)
  ctx.allocationWeights.base = 0
  const replay = await replayAtomicStrategySource(source, source.replacements[0], identity)
  assert.equal(replay.core_seed_replay.status, 'matched')
  if (replay.core_seed_replay.status !== 'matched') throw new Error('test replay missing')
  assert.equal(replay.core_seed_replay.scope, 'acknowledged_pre_ml_seed_request')
  assert.equal(replay.core_seed_replay.rows[0].seed.row.currentPrice, 100)
  assert.equal(replay.core_seed_replay.rows[0].eligibleForPendingBuy, true)
  assert.equal(replay.post_overlay!.input_status, 'incomplete', 'unrelated overlay stages still require actual replay')
  assert.equal(replay.promotion_allowed, false)
  assert.equal(replay.nav_maturity_credit, 0)
  assert.deepEqual(await replayAtomicStrategySource(source, source.replacements[0], identity), replay, 'retry is deterministic')
  assert.deepEqual(source, before)
})

test('missing/unverified Core observations are unavailable, not empty successful seeds', async () => {
  const { built, packet } = await fixture()
  for (const stage of ['core_seed_context', 'core_seed_materialization']) {
    for (const mode of ['missing', 'failed', 'unverified']) {
      const changed = structuredClone(packet)
      if (mode === 'missing') delete changed.observations[stage]
      else changed.observations[stage][0].status = mode as 'failed' | 'unverified'
      const source = await sealAtomicPostOverlaySource(built.source, changed)
      assert.equal((await replayAtomicStrategySource(source, source.replacements[0], identity)).core_seed_replay.status, 'unavailable')
    }
  }
  assert.equal((await replayAtomicStrategySource(built.source, built.source.replacements[0], identity)).core_seed_replay.status, 'unavailable')
  const empty = await fixture(true)
  const source = await sealAtomicPostOverlaySource(empty.built.source, empty.packet)
  const result = await replayAtomicStrategySource(source, source.replacements[0], identity)
  assert.equal(result.core_seed_replay.status, 'matched', 'explicit zero-hit day remains distinct from missing evidence')
  if (result.core_seed_replay.status === 'matched') assert.deepEqual(result.core_seed_replay.rows, [])
})

test('even a validly sealed packet rejects mismatched writes, malformed context and ambiguous observations', async () => {
  const { built, packet } = await fixture()
  const checks: Array<[RegExp, (value: typeof packet) => void]> = [
    [/replay_mismatch/, value => { (value.observations.core_seed_materialization[0].value as any).rows[0].seed.row.seedScore++ }],
    [/replay_mismatch/, value => { (value.observations.core_seed_materialization[0].value as any).rows.reverse() }],
    [/receipt_invalid/, value => { (value.observations.core_seed_materialization[0].value as any).write_status = 'failed' }],
    [/context_map_invalid/, value => { (value.observations.core_seed_context[0].value as any).context.prices.entries[0][1] = '100' }],
    [/context_map_invalid/, value => { (value.observations.core_seed_context[0].value as any).context.sectorBonus.entries[0][1] = { bonus: 5, avgCorr: 5 } }],
    [/observation_ambiguous/, value => { value.observations.core_seed_context.push(structuredClone(value.observations.core_seed_context[0])) }],
    [/observation_order_invalid/, value => { value.observations.core_seed_materialization[0].started_at = '2020-01-01T00:00:00Z' }],
    [/scope_invalid/, value => { (value.finalSeed as any[])[0].symbol = '9999' }],
    [/coverage_missing/, value => { (value.finalSeed as any[])[0].symbol = '2317' }],
  ]
  for (const [expected, mutate] of checks) {
    const changed = structuredClone(packet)
    mutate(changed)
    const source = await sealAtomicPostOverlaySource(built.source, changed)
    await assert.rejects(replayAtomicStrategySource(source, source.replacements[0], identity), expected)
  }
  const invalid = snapshot(context())
  invalid.prices.entries.push(invalid.prices.entries[0])
  assert.throws(() => decodeScreenerCoreSeedContext(invalid), /context_map_invalid/)
})

test('formal screener calls the shared materializer before acknowledged publication', () => {
  const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  const materialize = source.indexOf('materializeScreenerCoreSeeds(finalCandidates, coreSeedContext)')
  const write = source.indexOf('await writeScreenerSeedBatches', materialize)
  const receipt = source.indexOf("atomicOverlayCapture.record('core_seed_materialization'", write)
  const seal = source.indexOf('sealAtomicPostOverlaySource(', receipt)
  assert(materialize > 0 && write > materialize && receipt > write && seal > receipt)
  assert(source.includes("throw new Error('screener_seed_persistence_failed'"))
})
