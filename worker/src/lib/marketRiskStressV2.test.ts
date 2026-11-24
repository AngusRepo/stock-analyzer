import assert from 'node:assert/strict'
import {
  calibrateStoredRiskV2Score,
  computeStoredRiskV2,
  marketRiskLevelPolicy,
  scoreToRiskLevel,
  storedRiskV2FromQuality,
  validStoredRiskV2Policy,
} from './marketRiskStressV2'
import { DEFAULT_RISK_CONFIG, getRiskConfig } from './riskConfig'
import { combineMarketRiskLevel, confirmRegimeFamily } from './marketRiskRuntime'
import { fiveSlotSlotFloorRatio, inferFiveSlotTargetExposureFromContext } from './fiveSlotCapitalAllocator'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'

const portfolio = DEFAULT_RISK_CONFIG.portfolio
const levels = marketRiskLevelPolicy(portfolio)!
const benign = { vix: 12, twiiVol20: 10, twiiBias: 1, foreignConsecutiveSell: 0, foreignNet5d: 1, marginRatio: 1,
  adlTrend: 'up', bullAlignmentPct: 60 }
const v2 = (inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => computeStoredRiskV2({
  date: '2026-11-20', inputs, thresholds: levels.storedV2, v1Thresholds: levels.storedV1, policy: levels.storedRiskV2, ...extra,
})

// Defaults equal the decided behaviour (KV fields absent => same result as the decided values).
assert.deepEqual(portfolio.riskLevelThresholds, { storedV1: [25, 45, 65, 85], storedV2: [37.2, 56.4, 73.1, 91], factorPacket: [25, 45, 65, 85] })
assert.deepEqual(portfolio.storedRiskV2, { groupCaps: { volatility: 35, trend: 15, flow: 20, leverage: 0, breadth: 8 },
  foreignNet5dTrigger: 'net_sell', marginRatioPct: { elevated: 3.7, extreme: 3.8 } })
assert.equal(portfolio.regimeConfirmSessions, 2)
assert.equal(portfolio.storedBlackRequiresFastConfirmation, true)
assert.equal(portfolio.blackTargetExposure, 0)

// Each group counts once: VOL takes max(vix, vol20) × 35, not the sum.
const benignResult = v2(benign)
assert.equal(benignResult.score, 0)
assert.equal(benignResult.level, 'green')
assert.equal(benignResult.status, 'complete')
const bothVol = v2({ ...benign, vix: 45, twiiVol20: 45 })
const vixOnly = v2({ ...benign, vix: 45 })
assert.equal(bothVol.score, vixOnly.score)
assert.equal(bothVol.groups.volatility.points, 35)
assert.equal(bothVol.score, Math.round(35 * 100 / 78 * 10) / 10)

// Foreign 5-day net: any net sell triggers (sign only), never an amount threshold.
assert.equal(v2({ ...benign, foreignNet5d: -0.01 }).groups.flow.members.foreign_net_5d.severity, 1)
assert.equal(v2({ ...benign, foreignNet5d: 0 }).groups.flow.members.foreign_net_5d.severity, 0)
assert.equal(v2({ ...benign, foreignNet5d: -5000 }).groups.flow.points, 20)
assert.equal(v2({ ...benign, foreignNet5d: -5000 }).policy.foreign_net_5d_trigger, 'net_sell')

// Missing inputs: upper_bound scores the member at full severity; omit scores 0; FLOW missing iff the 5-day net is.
const missingFlow = v2({ ...benign, foreignNet5d: null })
assert.equal(missingFlow.status, 'bounded')
assert.deepEqual(missingFlow.missing, ['foreign_consecutive_sell', 'foreign_net_5d'])
assert.equal(missingFlow.groups.flow.points, 20)
assert.equal(v2({ ...benign, foreignNet5d: null }, { missingPolicy: 'omit' }).groups.flow.points, 0)
// Bounded margin receipt scores its upper ratio (leverage cap is 0 by default, so test with a cap).
const levPolicy = { ...levels.storedRiskV2, groupCaps: { ...levels.storedRiskV2.groupCaps, leverage: 10 } }
const bounded = v2({ ...benign, marginRatio: null }, { policy: levPolicy, marginSource: { status: 'bounded', ratio_lower: 3.0, ratio_upper: 3.75 } })
assert.equal(bounded.groups.leverage.members.margin_ratio.severity, 0.5)
assert.equal(bounded.groups.leverage.members.margin_ratio.value, 3.75)
assert.ok(bounded.missing.includes('margin_ratio'))
assert.equal(v2({ ...benign, marginRatio: 3.8 }, { policy: levPolicy }).groups.leverage.members.margin_ratio.severity, 1)
assert.equal(v2({ ...benign, marginRatio: 3.69 }, { policy: levPolicy }).groups.leverage.members.margin_ratio.severity, 0)

// Thresholds are inclusive upper cuts; calibration maps v2 cuts onto v1 cuts piecewise linearly.
assert.equal(scoreToRiskLevel(37.2, levels.storedV2), 'green')
assert.equal(scoreToRiskLevel(37.3, levels.storedV2), 'yellow')
assert.equal(scoreToRiskLevel(91.1, levels.storedV2), 'black')
assert.equal(calibrateStoredRiskV2Score(0, levels.storedV2, levels.storedV1), 0)
assert.equal(calibrateStoredRiskV2Score(37.2, levels.storedV2, levels.storedV1), 25)
assert.equal(calibrateStoredRiskV2Score(91, levels.storedV2, levels.storedV1), 85)
assert.equal(calibrateStoredRiskV2Score(100, levels.storedV2, levels.storedV1), 100)
for (const score of [0, 10, 37.2, 50, 56.4, 73.1, 80, 91, 95, 100]) {
  assert.equal(scoreToRiskLevel(calibrateStoredRiskV2Score(score, levels.storedV2, levels.storedV1), levels.storedV1),
    scoreToRiskLevel(score, levels.storedV2), `calibrated score keeps the level at ${score}`)
}

// Invalid policies fail closed (runtime blocks instead of guessing).
assert.equal(validStoredRiskV2Policy({ ...levels.storedRiskV2, foreignNet5dTrigger: -50 }), false)
assert.equal(validStoredRiskV2Policy({ ...levels.storedRiskV2, groupCaps: { volatility: 0, trend: 0, flow: 0, leverage: 0, breadth: 0 } }), false)
assert.equal(validStoredRiskV2Policy({ ...levels.storedRiskV2, marginRatioPct: { elevated: 3.8, extreme: 3.7 } }), false)
// Unknown group keys (which would change the rescale denominator) are rejected, and only the 5 groups count.
assert.equal(validStoredRiskV2Policy({ ...levels.storedRiskV2, groupCaps: { ...levels.storedRiskV2.groupCaps, sentiment: 100 } as any }), false)
assert.equal(validStoredRiskV2Policy({ ...levels.storedRiskV2, groupCaps: { ...levels.storedRiskV2.groupCaps, note: 'x' } as any }), false)
assert.equal(v2({ ...benign, vix: 45 }, { policy: { ...levels.storedRiskV2, groupCaps: { ...levels.storedRiskV2.groupCaps, sentiment: 100 } } }).score,
  v2({ ...benign, vix: 45 }).score)
assert.equal(marketRiskLevelPolicy({ ...portfolio, riskLevelThresholds: { ...portfolio.riskLevelThresholds, storedV2: [50, 40, 60, 70] as any } }), null)
assert.equal(storedRiskV2FromQuality({ date: '2026-11-20' }, portfolio), null)
assert.equal(storedRiskV2FromQuality({ date: '2026-11-20', inputs: benign }, portfolio)!.level, 'green')
assert.equal(storedRiskV2FromQuality({ date: '2026-11-20', status: 'blocked', inputs: benign }, portfolio)!.status, 'blocked')

// Regime confirmation: a family takes effect after N consecutive verified sessions; nulls neither confirm nor reset.
assert.equal(confirmRegimeFamily(['bull', 'bull', 'bear'], 2), 'bull')
assert.equal(confirmRegimeFamily(['bull', 'bull', 'bear', 'bear'], 2), 'bear')
assert.equal(confirmRegimeFamily(['bull', 'bull', 'bear', null, 'bear'], 2), 'bear')
// No family confirmed inside the window: the severer of the oldest and today's family, never the milder.
assert.equal(confirmRegimeFamily(['bull', 'bear', 'bull', 'bear'], 2), 'bear')
assert.equal(confirmRegimeFamily(['bear', 'bull', 'sideways', 'bull', 'sideways', 'bull'], 2), 'bear')
assert.equal(confirmRegimeFamily(['sideways', 'bull', 'volatile', 'bull'], 2), 'sideways')
assert.equal(confirmRegimeFamily(['bear'], 2), 'bear')
assert.equal(confirmRegimeFamily(['sideways', 'bear'], 1), 'bear')
assert.equal(confirmRegimeFamily([], 2), null)

// Level owner: stored black without a fast confirmation is capped at red; HMM bear maps to red.
const combine = (extra: Record<string, unknown>) => combineMarketRiskLevel({ factorPacketLevel: 'yellow', storedRiskLevel: 'black',
  shockLevel: null, breadthLevel: null, regimeFamily: 'bull', constructiveVolatile: false, storedBlackRequiresFastConfirmation: true, ...extra } as any)
assert.deepEqual([combine({}).level, combine({}).storedBlackCapped], ['red', true])
assert.equal(combine({ shockLevel: 'red' }).level, 'black')
assert.equal(combine({ breadthLevel: 'black' }).level, 'black')
assert.equal(combine({ breadthLevel: 'orange' }).level, 'red')
assert.equal(combine({ storedBlackRequiresFastConfirmation: false }).level, 'black')
assert.equal(combine({ storedRiskLevel: 'green', breadthLevel: 'black' }).level, 'black')
assert.equal(combine({ storedRiskLevel: 'green', regimeFamily: 'bear' }).level, 'red')

// Five-slot black exposure comes from KV (default 0); a positive KV value is honoured and capped.
assert.equal(inferFiveSlotTargetExposureFromContext({ marketRiskLevel: 'black', riskScore: 95 }), 0)
assert.equal(inferFiveSlotTargetExposureFromContext({ marketRiskLevel: 'black', riskScore: 95, blackTargetExposure: 0.2, targetExposureCap: 0.2 }), 0.2)
assert.equal(inferFiveSlotTargetExposureFromContext({ marketRiskLevel: 'black', riskScore: 95, blackTargetExposure: 0.2, targetExposureCap: 0.1 }), 0.1)
// Blocked runtime (no cap): black stays 0 even when KV admits black exposure.
assert.equal(inferFiveSlotTargetExposureFromContext({ marketRiskLevel: 'black', riskScore: 95, blackTargetExposure: 0.2, targetExposureCap: null }), 0)
const topCandidate: any = { symbol: '2330', buySignal: true, l5Pass: true, s12Ready: true, rank: 95, confidence: 0.9 }
// Slot floor caps come from KV slotFloorCapByLevel; defaults equal the previous hardcoded caps.
assert.deepEqual(portfolio.slotFloorCapByLevel, { green: 0.75, yellow: 0.65, orange: 0.55, red: 0.45, black: 0 })
assert.equal(portfolio.blackHaltsNewBuys, true)
assert.equal(fiveSlotSlotFloorRatio(topCandidate, 'black').ratio, 0)
assert.equal(fiveSlotSlotFloorRatio(topCandidate, 'red').ratio, 0.45)
assert.equal(fiveSlotSlotFloorRatio(topCandidate, 'green').ratio, 0.75)
assert.equal(fiveSlotSlotFloorRatio(topCandidate, 'black', { ...portfolio.slotFloorCapByLevel, black: 0.3 }).ratio, 0.3)
assert.equal(fiveSlotSlotFloorRatio(topCandidate, 'red', { ...portfolio.slotFloorCapByLevel, red: Number.NaN }).ratio, 0)

// P3: black halts new buys exactly when the runtime says so (KV blackHaltsNewBuys); a non-halting black sizes like red.
const p3Deps: any = { defaults: { halt: false, maxPositionPct: 0.08, buyConfThreshold: 0.6, sellConfThreshold: 0.65 }, effectiveBuy: 0.6, effectiveSell: 0.65 }
const p3Context: any = { status: 'ready', level: 'black', score: 90, date: '2026-11-20', reasons: ['x'], blockers: [], targetExposureCap: 0, deRiskExistingPositions: true }
void (async () => {
  const halted: any = await checkP3MarketRisk({ ...p3Context, haltNewBuys: true }, DEFAULT_TRADING_CONFIG, p3Deps)
  assert.equal(halted.halt, true); assert.equal(halted.maxPositionPct, 0)
  const open: any = await checkP3MarketRisk({ ...p3Context, haltNewBuys: false }, DEFAULT_TRADING_CONFIG, p3Deps)
  const red: any = await checkP3MarketRisk({ ...p3Context, level: 'red', haltNewBuys: false }, DEFAULT_TRADING_CONFIG, p3Deps)
  assert.notEqual(open.halt, true); assert.equal(open.maxPositionPct, red.maxPositionPct)
})().catch(error => { console.error(error); process.exit(1) })

// KV deep merge: a partial nested object keeps the remaining defaults.
void (async () => {
  const kv = { get: async () => ({ portfolio: { riskLevelThresholds: { storedV2: [30, 50, 70, 90] }, storedRiskV2: { groupCaps: { leverage: 5 } } } }) } as any
  const cfg = await getRiskConfig(kv)
  assert.deepEqual(cfg.portfolio.riskLevelThresholds.storedV1, [25, 45, 65, 85])
  assert.deepEqual(cfg.portfolio.riskLevelThresholds.storedV2, [30, 50, 70, 90])
  assert.equal(cfg.portfolio.storedRiskV2.groupCaps.leverage, 5)
  assert.equal(cfg.portfolio.storedRiskV2.groupCaps.volatility, 35)
  assert.equal(cfg.portfolio.storedRiskV2.foreignNet5dTrigger, 'net_sell')
  assert.equal(cfg.portfolio.regimeConfirmSessions, 2)
  assert.ok(marketRiskLevelPolicy(cfg.portfolio))
  // A nested field with the wrong container type is kept, so the level policy blocks instead of defaulting.
  for (const portfolio of [{ riskLevelThresholds: [1, 2, 3, 4] }, { storedRiskV2: 'garbage' }, { storedRiskV2: { groupCaps: [35] } },
    { storedBlackRequiresFastConfirmation: 'false' }]) {
    const bad = await getRiskConfig({ get: async () => ({ portfolio }) } as any)
    assert.equal(marketRiskLevelPolicy(bad.portfolio), null, JSON.stringify(portfolio))
  }
  // Mutating the returned config must not leak into the program defaults.
  cfg.portfolio.storedRiskV2.groupCaps.trend = 99
  assert.equal(DEFAULT_RISK_CONFIG.portfolio.storedRiskV2.groupCaps.trend, 15)
  console.log('marketRiskStressV2 tests passed')
})().catch(error => { console.error(error); process.exit(1) })
