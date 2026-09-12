import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScreenerOverlayCapture } from './screenerOverlayCapture'
import { buildLayer1WithAtomicSource, sealAtomicPostOverlaySource, replayAtomicStrategySource } from './atomicStrategyShadow'
import type { StrategySpec } from './strategySpec'

const symbolic = ['news_sentiment', 'external_risk', 'technical_history', 'selection_history', 'recent_sessions', 'sector_bonus']
const globalSources = ['theme_context', 'foreign_flow', 'theme_keywords', 'theme_ptt', 'theme_news', 'theme_anue', 'theme_runtime', 'core_seed_context', 'core_seed_materialization', 'core_seed_persistence']
const input = { signalDate: '2099-09-09', universeSymbols: ['2330', '2317'], formalSymbols: ['2330'],
  finalSeed: [{ symbol: '2330', score: 52 }], safetyExcludedSymbols: [], policy: { highFreqPenalty: 6 } }

test('actual capture partitions original scope, detaches raw values and preserves failures without replacing formal results', async () => {
  const capture = new ScreenerOverlayCapture()
  const calls: string[][] = []
  const formal = new Map([['2330', { score: 52 }]])
  const result = await capture.partitioned('technical_history', ['2330'], ['2330', '2317'], async symbols => {
    calls.push([...symbols])
    if (symbols.includes('2317')) throw new Error('test-secret-must-not-be-persisted')
    return formal
  })
  assert.equal(result, formal)
  assert.deepEqual(calls, [['2330'], ['2317']])
  formal.get('2330')!.score = 99
  const packet = capture.freeze(input)
  assert.deepEqual(packet.observations.technical_history[0].value, { entries: [['2330', { score: 52 }]] })
  assert.equal(packet.observations.technical_history[1].status, 'failed')
  assert.equal(packet.input_status, 'incomplete')
  assert(packet.issues.includes('technical_history:coverage_missing'))
  assert(packet.issues.includes('core_seed_persistence:not_captured'))
  assert(!JSON.stringify(packet).includes('test-secret'))
  assert.equal(packet.promotion_allowed, false)
  assert.equal(packet.nav_maturity_credit, 0)
  await assert.rejects(capture.partitioned('news_sentiment', ['2330'], ['2330', '2317'], async () => {
    throw new Error('formal failure')
  }), /formal failure/)
  assert.equal(capture.freeze(input).observations.news_sentiment.length, 1, 'cannot silently retry using a different scope')
})

test('successful empty observations differ from failures, missing identities and late live feeds', async () => {
  const capture = new ScreenerOverlayCapture()
  for (const name of symbolic) await capture.partitioned(name, ['2330'], input.universeSymbols, async () => [])
  for (const name of globalSources) capture.record(name, [])
  const packet = capture.freeze(input)
  assert.equal(packet.input_status, 'captured')
  assert.equal(packet.replay_status, 'not_evaluated', 'source capture is not proof of decision parity')
  assert.deepEqual(packet.issues, [])
  const before = structuredClone(packet)
  capture.record('theme_ptt', ['later changed'])
  assert.deepEqual(packet, before)
  await capture.read('news_sentiment', ['2317'], async () => ({ rows: [], missing_identity_symbols: ['2317'] }))
  assert(capture.freeze(input).issues.includes('news_sentiment:identity_missing'))
  assert(capture.freeze({ ...input, signalDate: '2000-01-01' }).issues.includes('theme_ptt:observed_after_signal_day'))
  await assert.rejects(capture.read('foreign_flow', null, async () => [NaN]), /nonfinite/)
  assert(capture.freeze(input).issues.includes('foreign_flow:failed'))
  const empty = new ScreenerOverlayCapture()
  let reads = 0
  for (const name of symbolic) await empty.partitioned(name, [], [], async symbols => {
    reads++
    assert.deepEqual(symbols, [])
    return []
  })
  for (const name of globalSources) empty.record(name, [])
  assert.equal(reads, symbolic.length)
  assert.equal(empty.freeze({ ...input, universeSymbols: [], formalSymbols: [], finalSeed: [] }).input_status, 'captured')
})

test('post-overlay append is immutable/checksum-bound, time-checked, and returned by original replay owner', async () => {
  const spec: StrategySpec = { id: 'base', version: 'strategy-spec-v1', name: 'base', status: 'active', owner: 'strategy',
    ownerType: 'strategy', promotionStatus: 'production', familyId: 'TREND_RECLAIM_CONTINUATION', variantId: 'base',
    alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'test', thresholds: { minFactorSignals: { base: .5 } },
    candidatePolicy: { poolQuota: 10, costBudget: 10 }, riskNotes: [], createdBy: 'p5_strategy_governance' }
  const built = await buildLayer1WithAtomicSource({ signalDate: input.signalDate, producerRunId: 'local-only',
    observedAt: '2020-01-01T00:00:00Z', specs: [spec, { ...spec, id: 'new', variantId: 'new',
      status: 'candidate', promotionStatus: 'candidate' }],
    options: { targetSize: 10, coarseMlQueueSize: 10, regime: 'bull',
      strategyWeights: { base: 1, new: 1 }, productionStrategyWeights: { base: 1, new: 0 } },
    universe: input.universeSymbols.map(symbol => ({ symbol, current_price: 50, eligible_for_ml: 1,
      market_segment: 'LISTED', raw_signals: { close: 50, factorSignals: { base: .9 } } })) })
  const before = structuredClone(built.source)
  const capture = new ScreenerOverlayCapture()
  const packet = capture.freeze({ ...input, formalSymbols: built.plan.breadthPool.map(row => row.symbol) })
  // Explicitly incomplete is retained, not disguised as a no-hit day.
  const sealed = await sealAtomicPostOverlaySource(built.source, packet)
  packet.finalSeed = ['mutation after sealing']
  assert.deepEqual(built.source, before)
  assert.notEqual(sealed.source_checksum, built.source.source_checksum)
  const identity = { signalDate: input.signalDate, producerRunId: 'local-only',
    artifactCreatedAt: '2099-09-09T12:00:00Z', decisionDeadline: '2099-09-10T00:00:00Z' }
  const result = await replayAtomicStrategySource(sealed, sealed.replacements[0], identity)
  assert.deepEqual(result.post_overlay!.finalSeed, input.finalSeed)
  assert.equal(result.post_overlay!.input_status, 'incomplete')
  await assert.rejects(sealAtomicPostOverlaySource(sealed, packet), /already_sealed/)
  await assert.rejects(sealAtomicPostOverlaySource(built.source, { ...packet,
    observations: { future: [{ started_at: '2099-09-10T00:00:00Z', completed_at: '2099-09-10T00:00:01Z',
      symbols: null, status: 'captured', value: [] }] } }), /post_overlay_time_invalid/)
  const changed = structuredClone(sealed)
  changed.post_overlay!.finalSeed = []
  await assert.rejects(replayAtomicStrategySource(changed, changed.replacements[0], identity), /lineage_or_time_invalid/)
  const late = await sealAtomicPostOverlaySource(built.source, { ...packet, completed_at: '2099-09-10T00:00:00Z' })
  await assert.rejects(replayAtomicStrategySource(late, late.replacements[0], identity), /post_overlay_time_invalid/)
})
