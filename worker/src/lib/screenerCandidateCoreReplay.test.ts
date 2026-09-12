import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replayFrozenCandidateCoreSeeds } from './screenerCandidateCoreReplay'
import { ScreenerOverlayCapture } from './screenerOverlayCapture'
import { decodeScreenerCoreSeedContext, type CoreSeedCandidate, type ScreenerCoreSeedContext } from './screenerCoreSeedMaterializer'
import { buildScreenerBreeze2Requests, mapScreenerBreeze2Candidates, breeze2AdvisoryCacheKey } from './breeze2Runtime'

const signalDate = '2099-09-09'
const replacement = { incumbentId: 'base', candidateId: 'new' }
function candidate(symbol = '1001', semantic = false): CoreSeedCandidate {
  return { symbol, name: symbol, industry: 'Semiconductor', sector: 'Semiconductor', reason: 'frozen reason',
    chip_score: 20, tech_score: 18, momentum_score: 10, strategy_pool_ids: ['new'],
    score_components: { version: 'score_v2', total: semantic ? 90 : 48, finalScore: semantic ? 90 : 48,
      components: { mlEdge: 20, chipFlow: 20, technicalStructure: 20, fundamentalQuality: 20, newsTheme: 0 } } }
}
async function fixture(rows = [candidate()]) {
  const symbols = ['1000', '1001', '9999']
  const context: ScreenerCoreSeedContext = { prices: new Map(symbols.map(symbol => [symbol, 100])),
    selectionFlags: new Map(), sectorBonus: new Map([['1000', { bonus: 123, avgCorr: .99 }]]),
    breezeWatchPoints: new Map([['1001', 'borrowed_formal_text_must_not_survive']]),
    chipMetadata: new Map(symbols.map(symbol => [symbol, null])), taxonomyPoints: new Map(symbols.map(symbol => [symbol, 'taxonomy:finlab'])),
    tpexSymbols: new Set(['1001']), allocationWeights: { base: .23, new: 0, other: .77 } }
  const capture = new ScreenerOverlayCapture()
  capture.record('core_seed_context', { context, breeze2Scope: rows.map(row => row.symbol), breeze2ScreenerContext: new Map(rows.map(row => [row.symbol, {
    schema_version: 'breeze2-research-context-v1', allowed_use: 'research_context_only', decision_effect: 'advisory_only',
    primary_candidate_source_allowed: false, recommended_decision_context: 'local_frozen', scores: { fact_support: .8 },
  }])) })
  await capture.read('selection_history', symbols, async () => new Map(symbols.map(symbol => [symbol,
    { highFreq: false, newMoney: true, freq20d: 0 }])))
  await capture.read('sector_bonus', symbols, async () => ({ schema_version: 'sector-bonus-frozen-inputs-v1', signal_date: signalDate,
    corr_threshold: .7, bonus_points: 5, source_status: 'captured', issues: [],
    full_industry_universe: symbols.map(symbol => ({ symbol, sector: symbol === '9999' ? 'Unrelated' : 'Semiconductor' })),
    inputs: { candidates: symbols.map(symbol => ({ symbol, sector: symbol === '9999' ? 'Unrelated' : 'Semiconductor' })),
      leaderRows: [{ symbol: '1000', sector: 'Semiconductor' }], prices: symbols.flatMap(symbol => Array.from({ length: 65 }, (_, i) => ({
        symbol, date: new Date(Date.UTC(2099, 0, i + 1)).toISOString().slice(0, 10), close: 100 + i + Math.sin(i),
      }))) } }))
  const packet = capture.freeze({ signalDate, universeSymbols: symbols, formalSymbols: rows.map(row => row.symbol), finalSeed: rows,
    safetyExcludedSymbols: [], policy: {} })
  return { packet, rows }
}

test('candidate owns Core score, frequency, numeric allocation and semantic request selection; source stays immutable', async () => {
  const { packet, rows } = await fixture(), before = structuredClone(packet)
  const result = await replayFrozenCandidateCoreSeeds(packet, rows, replacement)
  assert.equal(result.status, 'materialized')
  if (result.status !== 'materialized') throw new Error('missing candidate')
  assert.deepEqual(result.allocation_weights, { base: 0, new: .23, other: .77 })
  assert.equal(result.rows[0].seed.row.seedScore, 53)
  assert.equal(result.rows[0].eligibleForPendingBuy, true)
  assert.equal(result.rows[0].marketSegment, 'OTC')
  assert(!result.rows[0].watchPoints.includes('borrowed_formal_text_must_not_survive'))
  assert.deepEqual(result.semantic_requests, [])
  assert.equal(result.nav_maturity_credit, 0)
  assert.deepEqual(packet, before)
  assert.deepEqual(await replayFrozenCandidateCoreSeeds(packet, rows, replacement), result)
  const decoded = decodeScreenerCoreSeedContext((packet.observations.core_seed_context[0].value as any).context)
  decoded.allocationWeights.base = 0
  assert.deepEqual(packet, before, 'decoder cannot leak allocation mutations into sealed source')
})

test('same symbol is insufficient: changed reason or request rank requires candidate semantic inference', async () => {
  const { packet, rows } = await fixture([candidate('1001', true)])
  const same = await replayFrozenCandidateCoreSeeds(packet, rows, replacement)
  assert.equal(same.status, 'materialized')
  if (same.status !== 'materialized') throw new Error('missing frozen report')
  assert.equal(same.semantic_requests.length, 1)
  assert(same.rows[0].watchPoints.some(point => point.includes('breeze2:local_frozen')))
  const changed = await replayFrozenCandidateCoreSeeds(packet, [{ ...rows[0], reason: 'candidate-specific reason' }], replacement)
  assert.equal(changed.status, 'unavailable')
  if (changed.status !== 'unavailable') throw new Error('borrowed semantic result')
  assert.equal(changed.reason, 'breeze2:candidate_request_not_observed')
  assert.equal(changed.pending_semantic_requests[0].reason, 'candidate-specific reason')
  const first = candidate('1000', true), second = candidate('1001', true)
  const a = buildScreenerBreeze2Requests(mapScreenerBreeze2Candidates([first, second]), { runDate: signalDate })
  const b = buildScreenerBreeze2Requests(mapScreenerBreeze2Candidates([second]), { runDate: signalDate })
  assert.notEqual(await breeze2AdvisoryCacheKey(a[1]), await breeze2AdvisoryCacheKey(b[0]))
})

test('candidate source absence remains explicit; unrelated sector failure does not erase the covered candidate', async () => {
  const { packet, rows } = await fixture()
  for (const stage of ['selection_history', 'sector_bonus']) {
    const changed = structuredClone(packet)
    changed.observations[stage][0].status = 'failed'
    const result = await replayFrozenCandidateCoreSeeds(changed, rows, replacement)
    assert.equal(result.status, 'unavailable')
  }
  const changed = structuredClone(packet), sector = changed.observations.sector_bonus[0].value as any
  sector.source_status = 'incomplete'; sector.issues = ['price_history_missing:9999']
  assert.equal((await replayFrozenCandidateCoreSeeds(changed, rows, replacement)).status, 'materialized')
  sector.issues = ['price_history_missing:1000']
  const peerMissing = await replayFrozenCandidateCoreSeeds(changed, rows, replacement)
  assert.equal(peerMissing.status, 'unavailable', 'missing peer may change correlation and leader ranking')
  sector.issues = ['unknown_source_failure']
  assert.equal((await replayFrozenCandidateCoreSeeds(changed, rows, replacement)).status, 'unavailable')
  for (const field of ['prices', 'chipMetadata', 'taxonomyPoints']) {
    const missing = structuredClone(packet)
    ;(missing.observations.core_seed_context[0].value as any).context[field].entries = []
    assert.equal((await replayFrozenCandidateCoreSeeds(missing, rows, replacement)).status, 'unavailable')
  }
})

test('future/duplicate sector price and mismatched taxonomy reject; explicit no picks needs no overlay observations', async () => {
  const { packet, rows } = await fixture()
  for (const mutate of [(raw: any) => { raw.prices[0].date = '2100-01-01' },
    (raw: any) => { raw.prices.push(raw.prices[0]) }]) {
    const changed = structuredClone(packet)
    mutate((changed.observations.sector_bonus[0].value as any).inputs)
    await assert.rejects(replayFrozenCandidateCoreSeeds(changed, rows, replacement), /sector_price_invalid/)
  }
  const changed = structuredClone(packet)
  ;(changed.observations.sector_bonus[0].value as any).inputs.candidates[1].sector = 'Wrong'
  assert.equal((await replayFrozenCandidateCoreSeeds(changed, rows, replacement)).status, 'unavailable')
  delete changed.observations.selection_history
  delete changed.observations.sector_bonus
  const empty = await replayFrozenCandidateCoreSeeds(changed, [], replacement)
  assert.equal(empty.status, 'materialized')
  if (empty.status === 'materialized') assert.deepEqual(empty.rows, [])
})
