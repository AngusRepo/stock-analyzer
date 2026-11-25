import assert from 'node:assert/strict'
import { buildMarketRegimeFactorPacket, factorPacketBandScore, factorPacketBandWarn, validFactorPacketPolicy } from './marketRegimeFactorPacket'
import { DEFAULT_RISK_CONFIG, getRiskConfig } from './riskConfig'

// The packet is point-in-time: building it must not touch the network, so a rebuild reproduces the original.
// Moving the bands to KV changes no score: the KV defaults reproduce the hardcoded expressions they replace on a
// dense grid. Exception, decided separately: chips is the sign rule (<0 -> 85, >0 -> 20, else 40; warn <0), not
// HEAD's net-flow bands (< -250 -> 85, < -80 -> 65, > 120 -> 20; warn < -80).
{
  const P = DEFAULT_RISK_CONFIG.portfolio.factorPacketPolicy
  const old = {
    priceTrend: (v: number) => [v <= -6 ? 85 : v <= -3 ? 65 : v >= 3 ? 20 : 40, v <= -3],
    businessCycle: (v: number) => [v <= 16 ? 85 : v <= 22 ? 62 : v <= 31 ? 38 : v <= 37 ? 55 : 72, false],
    chips: (v: number) => [v < 0 ? 85 : v > 0 ? 20 : 40, v < 0],
    leverage: (v: number) => [v > 8 ? 75 : v > 3 ? 55 : v < -5 ? 25 : 40, v > 3],
    volatilityVix: (v: number) => [v >= 35 ? 85 : v >= 25 ? 65 : v <= 16 ? 25 : 40, v >= 25],
    volatilityVol20: (v: number) => [v >= 35 ? 80 : v >= 24 ? 60 : 35, v >= 25],
  } as const
  let checked = 0
  for (const [key, fn] of Object.entries(old)) {
    const rule = (P as any)[key]
    for (let v = -60; v <= 60; v += 0.25) {
      const [score, warn] = fn(v)
      assert.equal(factorPacketBandScore(rule, v), score, `${key} score at ${v}`)
      if (key !== 'businessCycle') assert.equal(factorPacketBandWarn(rule, v), warn, `${key} warn at ${v}`)
      checked += 1
    }
  }
  assert.ok(checked > 2800)
  assert.deepEqual(P.weights, { price_trend: 0.20, business_cycle: 0.15, chips: 0.15, leverage: 0.15, volatility: 0.10, macro: 0.10, global: 0.10, event_monitors: 0.05 })
  assert.deepEqual([P.missingScore, P.evidenceStanceScores, P.eventMonitorWarn], [45, { bearish: 75, bullish: 15, neutral: 40 }, 0.7])
  // Validator: weights must sum to 1, bands in range, no unknown weight keys.
  assert.equal(validFactorPacketPolicy(P), true)
  const bad = (edit: (p: any) => void) => { const p: any = structuredClone(P); edit(p); return validFactorPacketPolicy(p) }
  assert.equal(bad(p => { p.weights.chips = 0.2 }), false)
  assert.equal(bad(p => { p.weights.extra = 0 }), false)
  assert.equal(bad(p => { p.chips.bands[0].score = 101 }), false)
  assert.equal(bad(p => { p.chips.bands[0].op = '==' }), false)
  assert.equal(bad(p => { p.leverage.otherwise = Number.NaN }), false)
  assert.equal(bad(p => { p.priceTrend.warn = { op: '<=', cut: 'x' } }), false)
  assert.equal(bad(p => { p.evidenceStanceScores.bearish = -1 }), false)
  assert.equal(bad(p => { p.priceTrend = null }), false)
}
// KV merge: a partial policy keeps the other defaults; a wrong-typed one is kept so the builder refuses it.
void (async () => {
  const partial = await getRiskConfig({ get: async () => ({ portfolio: { factorPacketPolicy: { weights: { chips: 0.10, leverage: 0.20 } } } }) } as any)
  assert.equal(partial.portfolio.factorPacketPolicy.weights.chips, 0.10)
  assert.equal(partial.portfolio.factorPacketPolicy.weights.price_trend, 0.20)
  assert.deepEqual(partial.portfolio.factorPacketPolicy.chips, DEFAULT_RISK_CONFIG.portfolio.factorPacketPolicy.chips)
  assert.equal(validFactorPacketPolicy(partial.portfolio.factorPacketPolicy), true)
  const wrong = await getRiskConfig({ get: async () => ({ portfolio: { factorPacketPolicy: [1] } }) } as any)
  assert.equal(validFactorPacketPolicy(wrong.portfolio.factorPacketPolicy), false)
})().catch(error => { console.error(error); process.exit(1) })

const statement: any = { bind: () => statement, all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }
const db: any = { prepare: () => statement }
const realFetch = globalThis.fetch
let fetches = 0
globalThis.fetch = (async () => { fetches += 1; throw new Error('network_disabled_in_test') }) as any

void (async () => {
  try {
    const row = { date: '2026-11-20', twii_bias: -2, twii_vol20: 20, vix: 18, foreign_net_5d: -100 }
    const regimeState = { monitors: { lppls_weekly_bubble: { score: 30 }, hawkes_contagion: { score: 10 } } }
    const packet = await buildMarketRegimeFactorPacket(db, row, regimeState)
    assert.equal(fetches, 0, 'factor packet must not fetch live headlines')
    const ids = packet.factors.map((factor: any) => factor.id)
    assert.ok(ids.includes('business_cycle'), 'business-cycle tile id is business_cycle')
    assert.ok(!ids.includes('breadth'), 'the business-cycle tile is no longer mislabeled breadth')
    const events: any = packet.factors.find((factor: any) => factor.id === 'event_monitors')
    assert.ok(events, 'event monitor tile exists')
    assert.ok(!JSON.stringify(events).toLowerCase().includes('cnyes'), 'event monitor reads LPPLS/Hawkes only')
    // Level cuts come from the caller (KV factorPacket thresholds); identical score, stricter cuts => higher level.
    const strict = await buildMarketRegimeFactorPacket(db, row, regimeState, [0, 1, 2, 3])
    assert.equal(strict.score, packet.score)
    assert.ok(packet.score > 3, 'fixture score is above the strict black cut')
    assert.equal(strict.level, 'black')
    await assert.rejects(buildMarketRegimeFactorPacket(db, row, regimeState, [50, 40, 60, 70]), /factor_packet_level_thresholds_invalid/)
    // chips (KV factorPacketPolicy.chips sign bands): any 5-day net sell scores 85/warn, any net buy 20/ok.
    const chips = (p: any) => p.factors.find((factor: any) => factor.id === 'chips')
    assert.equal(chips(packet).score, 85); assert.equal(chips(packet).status, 'warn')
    const buy = await buildMarketRegimeFactorPacket(db, { ...row, foreign_net_5d: 50 }, regimeState)
    assert.equal(chips(buy).score, 20); assert.equal(chips(buy).status, 'ok')
    const flat = await buildMarketRegimeFactorPacket(db, { ...row, foreign_net_5d: 0 }, regimeState)
    assert.equal(chips(flat).score, 40)
    const none = await buildMarketRegimeFactorPacket(db, { ...row, foreign_net_5d: null }, regimeState)
    assert.equal(chips(none).score, 45); assert.equal(chips(none).status, 'missing')
    await assert.rejects(buildMarketRegimeFactorPacket(db, row, regimeState, undefined, 'cuts'), /factor_packet_policy_invalid/)
    // A KV policy drives the bands: chips sell scores 99 instead of 85 -> contribution +2.1.
    const custom = structuredClone(DEFAULT_RISK_CONFIG.portfolio.factorPacketPolicy)
    custom.chips.bands[0].score = 99
    const customPacket = await buildMarketRegimeFactorPacket(db, row, regimeState, undefined, custom)
    assert.equal(chips(customPacket).score, 99); assert.equal(chips(customPacket).contribution, 14.9)
    console.log('marketRegimeFactorPacket offline tests passed')
  } finally {
    globalThis.fetch = realFetch
  }
})().catch(error => { console.error(error); process.exit(1) })
