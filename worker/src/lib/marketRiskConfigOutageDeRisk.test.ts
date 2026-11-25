import assert from 'node:assert/strict'
import { buildCanonicalMarketRiskContext } from './marketRiskRuntime'
import { DEFAULT_RISK_CONFIG, getRiskConfig, riskScoringPolicy } from './riskConfig'
import { factorPacketBandScore, validFactorPacketPolicy } from './marketRegimeFactorPacket'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import { checkCanonicalMarketRestriction } from './riskChecks/canonicalMarketRestriction'
import { buildPortfolioDeRiskPlan } from './portfolioDeRisk'
import { fixtureQuality, fixtureProvenance, fixtureStoredRiskV2 } from './riskProtocol.testSupport'

// trading:risk_config unavailable must never be less safe than main: anything adding risk is blocked, while
// de-risking existing positions still runs on the built-in defaults at the most conservative level.
const P = DEFAULT_RISK_CONFIG.portfolio
const date = '2026-10-06'
const base: any = {
  marketRiskRows: [{ date, twii_close: 30000, risk_score: 0, risk_level: 'green' }, { date: '2026-10-05', twii_close: 29900, risk_score: 0, risk_level: 'green' }],
  factorPacket: { date, score: 0, level: 'green' }, breadth: { date, advance_ratio: .6, bull_alignment_pct: 60 },
  regimeState: { source: 'hmm', family: 'bull', run_date: date, regime_evidence: { hmm_provenance: fixtureProvenance(date, fixtureQuality(date, 0).checksum), evidence: {} } },
  quality: fixtureQuality(date, 0), storedRiskV2: fixtureStoredRiskV2(date, 0, 'green'), policy: P, expectedSession: date,
}
const orange = { ...base, regimeState: { ...base.regimeState, family: 'volatile' } }
const deps = {
  defaults: { halt: false, maxPositionPct: DEFAULT_TRADING_CONFIG.circuit.maxPositionPct,
    buyConfThreshold: DEFAULT_TRADING_CONFIG.circuit.buyConfThreshold, sellConfThreshold: DEFAULT_TRADING_CONFIG.circuit.sellConfThreshold },
  effectiveBuy: DEFAULT_TRADING_CONFIG.circuit.buyConfThreshold, effectiveSell: DEFAULT_TRADING_CONFIG.circuit.sellConfThreshold,
}

void (async () => {
  // Main-equivalent reference: the same inputs with the built-in defaults read from KV.
  const ready = buildCanonicalMarketRiskContext(orange)
  assert.equal(ready.status, 'ready'); assert.equal(ready.level, 'orange'); assert.equal(ready.deRiskExistingPositions, true)

  const kvs: Array<[string, any]> = [
    ['missing', { get: async () => null }], ['throws', { get: async () => { throw new Error('kv_down') } }],
    ['array', { get: async () => [] }], ['string', { get: async () => 'x' }],
    ['portfolio string', { get: async () => ({ portfolio: 'x' }) }], ['no portfolio', { get: async () => ({ system: { killSwitch: false } }) }],
  ]
  for (const [name, kv] of kvs) {
    const cfg = await getRiskConfig(kv)
    const ctx = buildCanonicalMarketRiskContext({ ...orange, policy: cfg.portfolio })
    // New buys / size-ups blocked with the explicit reason.
    assert.equal(ctx.status, 'blocked', name); assert.equal(ctx.haltNewBuys, true, name)
    assert.deepEqual(ctx.blockers, ['risk_config_unavailable'], name)
    const restriction = await checkCanonicalMarketRestriction(ctx, DEFAULT_TRADING_CONFIG, deps)
    assert.equal(restriction?.halt, true, name); assert.equal(restriction?.maxPositionPct, 0, name)
    // De-risk executes with the built-in cap, never looser than main.
    assert.equal(ctx.deRiskExistingPositions, true, name)
    assert.equal(ctx.targetExposureCap, P.orangeTargetExposure, name)
    assert.ok(ctx.targetExposureCap! <= ready.targetExposureCap!, name)
    assert.ok(ctx.reasons.includes('risk_config_degraded_derisk_level=orange'), name)
    const plan = buildPortfolioDeRiskPlan({ totalPortfolio: 1_000_000, targetExposure: ctx.targetExposureCap!,
      holdings: [{ symbol: '2330', shares: 1000, price: 900, weakness: 1 }] })
    assert.equal(plan.required, true, name)
    assert.ok(plan.projectedPositionsValue <= 1_000_000 * P.orangeTargetExposure + 1e-6, name)
  }

  const unavailable = { ...P, configUnavailable: true as const }
  // Calm market: blocked for new risk, nothing to de-risk (same as main at green).
  const calm = buildCanonicalMarketRiskContext({ ...base, policy: unavailable })
  assert.equal(calm.status, 'blocked'); assert.equal(calm.deRiskExistingPositions, false); assert.equal(calm.targetExposureCap, P.greenTargetExposure)
  // Black breadth: full de-risk to the built-in black cap.
  const black = buildCanonicalMarketRiskContext({ ...base, breadth: { ...base.breadth, advance_ratio: .05 }, policy: unavailable })
  assert.equal(black.deRiskExistingPositions, true); assert.equal(black.targetExposureCap, P.blackTargetExposure)
  // Most conservative of the components: main's v1 red de-risks even where the canonical level is green.
  const v1Red = { ...base, marketRiskRows: [{ ...base.marketRiskRows[0], risk_level: 'red' }, base.marketRiskRows[1]] }
  assert.equal(buildCanonicalMarketRiskContext(v1Red).deRiskExistingPositions, false)
  const v1RedOutage = buildCanonicalMarketRiskContext({ ...v1Red, policy: unavailable })
  assert.equal(v1RedOutage.deRiskExistingPositions, true); assert.equal(v1RedOutage.targetExposureCap, P.redTargetExposure)
  // Volatile HMM family without relief counts as orange while degraded.
  const volatile = buildCanonicalMarketRiskContext({ ...base, regimeState: { ...base.regimeState, family: 'volatile' }, policy: unavailable })
  assert.equal(volatile.deRiskExistingPositions, true); assert.equal(volatile.targetExposureCap, P.orangeTargetExposure)

  // A packet materialized during the outage blocks new risk once KV is back, and still de-risks.
  const flagged = buildCanonicalMarketRiskContext({ ...orange, factorPacket: { ...orange.factorPacket, lineage: { risk_config: 'unavailable_builtin_defaults' } } })
  assert.equal(flagged.status, 'blocked'); assert.deepEqual(flagged.blockers, ['factor_packet_built_without_risk_config'])
  assert.equal(flagged.haltNewBuys, true); assert.equal(flagged.deRiskExistingPositions, true); assert.equal(flagged.targetExposureCap, P.orangeTargetExposure)

  // Any other blocker (missing data) keeps main's behaviour: no level, no de-risk target.
  const noData = buildCanonicalMarketRiskContext({ ...orange, quality: null, policy: unavailable })
  assert.equal(noData.status, 'blocked'); assert.equal(noData.deRiskExistingPositions, false); assert.equal(noData.targetExposureCap, null)
  // Outage scoring policy: defaults, chips at the pointwise maximum of main's bands and the decided sign rule.
  const outagePolicy = riskScoringPolicy(unavailable)
  assert.equal(riskScoringPolicy(P), P)
  assert.equal(validFactorPacketPolicy(outagePolicy.factorPacketPolicy), true)
  assert.deepEqual({ ...outagePolicy.factorPacketPolicy, chips: null }, { ...P.factorPacketPolicy, chips: null })
  const mainChips = (v: number) => v < -250 ? 85 : v < -80 ? 65 : v > 120 ? 20 : 40
  const signChips = (v: number) => factorPacketBandScore(P.factorPacketPolicy.chips, v)
  for (let v = -400; v <= 400; v += 0.5) {
    assert.equal(factorPacketBandScore(outagePolicy.factorPacketPolicy.chips, v), Math.max(mainChips(v), signChips(v)), String(v))
  }
  console.log('risk config outage: new risk blocked, de-risk on built-in defaults PASS')
})().catch(error => { console.error(error); process.exit(1) })
