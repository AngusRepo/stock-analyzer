import assert from 'node:assert/strict'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { buildCanonicalMarketRiskContext } from './marketRiskRuntime'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import type { MarketRegimeState } from './marketRegimeState'
import type { MarketRegimeFactorPacket } from './marketRegimeFactorPacket'

const regime = {
  schema_version: 'market-regime-state-v1',
  label: 'sideways',
  raw_label: 'sideways',
  family: 'sideways',
  run_date: '2026-07-17',
  computed_at: '2026-07-17T14:00:00Z',
  source: 'hmm',
  regime_index: 2,
  hmm_state: 2,
  label_zh: '盤整',
  regime_surface: {},
  consensus_threshold: 0.6,
  weight_multipliers: {},
  regime_evidence: {},
  transition_guard: {},
  monitors: {},
  downstream_contract: {} as any,
} satisfies MarketRegimeState

const packet = {
  schema_version: 'market-regime-factor-packet-v1',
  date: '2026-07-17',
  score: 61,
  level: 'orange',
  factors: [],
  contributions: {},
  sources: {},
  freshness: {},
  missing_reasons: {},
  lineage: {},
  generated_at: '2026-07-17T14:01:00Z',
} satisfies MarketRegimeFactorPacket

const severeDrop = buildCanonicalMarketRiskContext({
  marketRiskRows: [
    { date: '2026-07-17', twii_close: 42671, risk_score: 61, risk_level: 'orange' },
    { date: '2026-07-16', twii_close: 45625, risk_score: 30, risk_level: 'yellow' },
  ],
  factorPacket: packet,
  breadth: { date: '2026-07-17', advance_ratio: 0.24, bull_alignment_pct: 0.35 },
  regimeState: regime,
  policy: DEFAULT_RISK_CONFIG.portfolio,
})

assert.equal(severeDrop.status, 'ready')
assert.equal(severeDrop.shockLevel, 'red', 'a -5% or worse TWII day must bypass weighted dilution and reach red')
assert.equal(severeDrop.level, 'red')
assert.equal(severeDrop.targetExposureCap, DEFAULT_RISK_CONFIG.portfolio.redTargetExposure)
assert.equal(severeDrop.deRiskExistingPositions, true)

const mismatched = buildCanonicalMarketRiskContext({
  marketRiskRows: [
    { date: '2026-07-17', twii_close: 42671, risk_score: 61, risk_level: 'orange' },
    { date: '2026-07-16', twii_close: 45625, risk_score: 30, risk_level: 'yellow' },
  ],
  factorPacket: { ...packet, date: '2026-07-16' },
  breadth: { date: '2026-07-17', advance_ratio: 0.24, bull_alignment_pct: 0.35 },
  regimeState: regime,
  policy: DEFAULT_RISK_CONFIG.portfolio,
})
assert.equal(mismatched.status, 'blocked')
assert.equal(mismatched.haltNewBuys, true)
assert.equal(mismatched.deRiskExistingPositions, false, 'missing/mismatched evidence must halt buys without blind liquidation')
assert(mismatched.blockers.includes('factor_packet_date_mismatch'))

const deps = {
  defaults: {
    halt: false,
    maxPositionPct: 0.08,
    buyConfThreshold: 0.6,
    sellConfThreshold: 0.65,
  },
  effectiveBuy: 0.6,
  effectiveSell: 0.65,
}

async function run(): Promise<void> {
  const healthyP3 = await checkP3MarketRisk({
    ...severeDrop,
    level: 'yellow',
    shockLevel: null,
    breadthLevel: null,
    deRiskExistingPositions: false,
    targetExposureCap: DEFAULT_RISK_CONFIG.portfolio.yellowTargetExposure,
  }, DEFAULT_TRADING_CONFIG, deps)
  assert.equal(healthyP3, null, 'green/yellow market risk must not be reported as a triggered P3 layer')

  const healthyBreadth = await checkP4Breadth({
    ...severeDrop,
    level: 'yellow',
    shockLevel: null,
    breadthLevel: null,
    deRiskExistingPositions: false,
    advanceRatio: 0.55,
    bullAlignmentRatio: 0.35,
  }, DEFAULT_TRADING_CONFIG, deps)
  assert.equal(healthyBreadth, null, '0.35 ratio must be compared with configured 20% as 0.20, not 20')

  const missingBreadth = await checkP4Breadth({
    ...mismatched,
    blockers: ['market_breadth_advance_ratio_missing'],
  }, DEFAULT_TRADING_CONFIG, deps)
  assert.equal(missingBreadth?.halt, true, 'missing breadth must fail closed for new buys')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
