import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fixtureQuality, fixtureStoredRiskV2, verifiedFixture } from './riskProtocol.testSupport'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { buildCanonicalMarketRiskContext } from './marketRiskRuntime'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import { runtimeMarketRiskDisplay } from './marketRiskDisplay'

const regime = {
  schema_version: 'market-regime-state-v1', label: 'sideways', raw_label: 'sideways', family: 'sideways',
  run_date: '2026-11-20', computed_at: '2026-11-20T14:00:00Z', source: 'hmm', regime_index: 2, hmm_state: 2,
  label_zh: '盤整', regime_surface: {}, consensus_threshold: 0.6, weight_multipliers: {}, regime_evidence: {},
  transition_guard: {}, monitors: {}, downstream_contract: {},
}
const packet = {
  schema_version: 'market-regime-factor-packet-v1', date: '2026-11-20', score: 78, level: 'red', factors: [],
  contributions: {}, sources: {}, freshness: {}, missing_reasons: {}, lineage: {}, generated_at: '2026-11-20T14:01:00Z',
}
// Packet red, one-day breadth at the black cut: trading uses black (the 11/20 case).
const context = (extra: Record<string, unknown> = {}) => buildCanonicalMarketRiskContext(verifiedFixture({
  marketRiskRows: [
    { date: '2026-11-20', twii_close: 27000, risk_score: 78, risk_level: 'red' },
    { date: '2026-11-19', twii_close: 27300, risk_score: 70, risk_level: 'red' },
  ],
  factorPacket: packet,
  breadth: { date: '2026-11-20', advance_ratio: 0.05, bull_alignment_pct: 20 },
  regimeState: regime,
  policy: DEFAULT_RISK_CONFIG.portfolio,
  ...extra,
}))
const deps = { defaults: { halt: false, maxPositionPct: 0.08, buyConfThreshold: 0.6, sellConfThreshold: 0.65 }, effectiveBuy: 0.6, effectiveSell: 0.65 }

test('display carries the level P3 trades on, not the factor packet level', async () => {
  const ctx = context()
  const view = runtimeMarketRiskDisplay(ctx, '2026-11-21T00:30:00.000Z')
  const p3 = await checkP3MarketRisk(ctx, DEFAULT_TRADING_CONFIG, deps)
  assert.equal(ctx.status, 'ready')
  assert.equal(packet.level, 'red')
  assert.equal(view.status, 'ready')
  assert.equal(view.level, 'black')
  assert.equal(view.level, p3?.marketRiskLevel)
  assert.equal(view.haltNewBuys, true)
  assert.equal(view.score, ctx.score)
  assert.equal(view.owner, ctx.lineage.owner)
})

test('a blocked runtime is shown as the black it trades as, with its blockers', () => {
  const ctx = context({ factorPacket: { ...packet, date: '2026-11-19' }, expectedSession: '2026-11-20' })
  const view = runtimeMarketRiskDisplay(ctx, '2026-11-21T00:30:00.000Z')
  assert.equal(view.status, 'blocked')
  assert.equal(view.level, 'black')
  assert.equal(view.haltNewBuys, true)
  assert.ok(view.blockers.includes('factor_packet_date_mismatch'))
})

// What resolveCanonicalMarketRisk reads on the evening of 11/20: decision date 11/20 expects 11/19, so the
// quality receipt and stored v2 are the 11/19 ones, while 11/20 market_risk / packet / breadth / HMM have landed.
const evening = (extra: Record<string, unknown> = {}) => context({
  expectedSession: '2026-11-19',
  expectedPreviousSession: '2026-11-18',
  quality: fixtureQuality('2026-11-19', 70, 27300, 27300, '2026-11-18'),
  storedRiskV2: fixtureStoredRiskV2('2026-11-19', 70, 'red'),
  ...extra,
})

test('after today\'s close the next session is awaiting, not a fabricated halt level', () => {
  const ctx = evening()
  assert.equal(ctx.status, 'blocked')
  assert.ok(ctx.blockers.includes('market_risk_expected_session_mismatch'))
  const view = runtimeMarketRiskDisplay(ctx, '2026-11-20T11:00:00.000Z') // 19:00 TW on 11/20
  assert.equal(view.status, 'awaiting_next_session')
  assert.equal(view.level, null)
  assert.equal(view.score, null)
  assert.equal(view.haltNewBuys, null)
  assert.equal(view.date, '2026-11-20')
  assert.equal(view.expectedSession, '2026-11-19')
})

test('a lagging expected session on a later day is a real halt, not awaiting', () => {
  // e.g. a wrong holiday:2026-11-20 key: on 11/21 the runtime still expects 11/19 and P3 halts all session.
  const view = runtimeMarketRiskDisplay(evening(), '2026-11-21T02:00:00.000Z')
  assert.equal(view.status, 'blocked')
  assert.equal(view.level, 'black')
  assert.equal(view.haltNewBuys, true)
})

test('evening without a previous-session receipt (stored v2 missing, HMM checksum mismatch) is still awaiting', () => {
  const ctx = evening({ quality: null, storedRiskV2: null })
  assert.ok(ctx.blockers.includes('stored_risk_v2_missing'))
  assert.ok(ctx.blockers.includes('hmm_model_input_contract_unverified'))
  assert.equal(runtimeMarketRiskDisplay(ctx, '2026-11-20T11:00:00.000Z').status, 'awaiting_next_session')
})

test('a same-day row that lands before the close (pre-open or intraday recompute) is a real halt', () => {
  for (const at of ['2026-11-20T00:30:00.000Z', '2026-11-20T03:00:00.000Z', '2026-11-20T05:20:00.000Z']) { // 08:30, 11:00, 13:20 TW
    const view = runtimeMarketRiskDisplay(evening(), at)
    assert.equal(view.status, 'blocked', at)
    assert.equal(view.level, 'black', at)
    assert.equal(view.haltNewBuys, true, at)
  }
})

test('an evening blocker that is not caused by the session shift stays blocked', () => {
  const ctx = evening({ breadth: { date: '2026-11-19', advance_ratio: 0.5, bull_alignment_pct: 50 } })
  assert.ok(ctx.blockers.includes('market_breadth_date_mismatch'))
  const view = runtimeMarketRiskDisplay(ctx, '2026-11-20T11:00:00.000Z')
  assert.equal(view.status, 'blocked')
  assert.equal(view.level, 'black')
  assert.equal(view.haltNewBuys, true)
})

test('GET /market/risk exposes the runtime level next to the packet level under a new cache key', () => {
  const route = readFileSync(new URL('../routes/other.ts', import.meta.url), 'utf8')
  const materialization = readFileSync(new URL('./marketRiskMaterialization.ts', import.meta.url), 'utf8')
  assert.ok(route.includes("const cacheKey = 'market:risk:latest:v21-runtime-level'"))
  assert.ok(route.includes('resolveCanonicalMarketRisk({'))
  assert.ok(route.includes('runtimeMarketRiskDisplay(context,'))
  assert.ok(route.includes('    runtimeRisk,\n'))
  assert.ok(route.includes("Math.min(runtimeRisk?.status === 'ready' ? 1800 : 300, untilTwMidnight)"), 'runtime level cache never spans the TW date change')
  assert.ok(route.includes('riskLevel:              factorPacket?.level ?? row.risk_level,'), 'packet level stays as is')
  assert.ok(materialization.includes("'market:risk:latest:v21-runtime-level'"), 'materialization clears the served key')
  const maintenance = readFileSync(new URL('./localMaintenance.ts', import.meta.url), 'utf8')
  assert.ok(maintenance.includes('...MARKET_RISK_LATEST_CACHE_KEYS'), 'warmup clears every served key version')
  const fallback = route.slice(route.indexOf('async function buildMarketRiskFallback'), route.indexOf('import type { Bindings, Variables }'))
  assert.ok(fallback.includes('riskScore: null') && fallback.includes('riskLevel: null') && fallback.includes("riskStatus: 'unavailable'"))
  assert.ok(!fallback.includes('riskScore: 50') && !fallback.includes("riskLevel: 'local_fallback'"), 'no placeholder score or level')
  assert.ok(fallback.includes('loadRuntimeMarketRisk(env)'), 'the fallback still reports the level trading uses')
})
