import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  L05_LIQUIDITY_CAPACITY_POLICY,
  L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM,
  compactL05LiquidityCapacityReceipt,
  evaluateL05LiquidityCapacity,
  expandL05LiquidityCapacityCompactReceipt,
} from './l05LiquidityCapacity'
import { selectScreenerFunnelItemsForPersistence } from './marketScreener'
import { buildHardGateSummary } from './recommendationContext'
import { summarizeScreenerFunnelRows, type ScreenerFunnelRow } from './screenerFunnelEvidence'

const passingReceipt = evaluateL05LiquidityCapacity(
  Array.from({ length: 20 }, (_, i) => ({ close: 100 + i / 3, Trading_Volume: 300_000 })),
  13_000_000,
)
const failingReceipt = evaluateL05LiquidityCapacity(
  Array.from({ length: 20 }, () => ({ close: 10, Trading_Volume: 1_000 })),
  13_000_000,
)

function scoringRow(symbol: string, liquidity?: unknown): ScreenerFunnelRow {
  return {
    symbol,
    stage: 'scoring',
    decision: 'pass',
    reason_code: 'base_score_computed',
    score_after: 61,
    evidence: JSON.stringify({
      score_components: { version: 'score_v2' },
      ...(liquidity === undefined ? {} : { l05_liquidity_capacity: liquidity }),
    }),
  }
}

function seedRow(symbol: string): ScreenerFunnelRow {
  return {
    symbol,
    stage: 'final_selection',
    decision: 'observe',
    reason_code: 'l1_candidate_seed',
    rank: 1,
    evidence: JSON.stringify({ strategy_pool_ids: ['s01'] }),
  }
}

function layer0(rows: ScreenerFunnelRow[], symbol: string): Record<string, any> {
  const summary = summarizeScreenerFunnelRows(rows).get(symbol)
  const out = summary?.evidence.layer0_universe_features as Record<string, any> | undefined
  assert(out, `layer0 summary missing for ${symbol}`)
  return out
}

function gateFor(l0: Record<string, any>) {
  return buildHardGateSummary({
    boardType: 'LISTED',
    tradabilityTier: 'auto_tradable',
    recommendationLane: 'tradable',
    eligibleForMl: true,
    eligibleForPendingBuy: true,
    liquidityPolicyVersion: l0.liquidity_policy_version,
    liquidityMetric: l0.liquidity_metric,
    liquidityObservedSessions: l0.liquidity_observed_sessions,
    medianDailyTradedValueTwd: l0.median_daily_traded_value_twd,
    minMedianDailyTradedValueTwd: l0.min_median_daily_traded_value_twd,
    liquidityCapacityPassed: l0.liquidity_capacity_passed,
    universePassed: l0.universe_passed,
    maturityImpact: l0.maturity_impact,
  })
}

test('missing universe row and no scoring receipt is unknown, never liquidity-blocked', () => {
  const l0 = layer0([scoringRow('2330'), seedRow('2330')], '2330')
  assert.equal(l0.liquidity_capacity_passed, null)
  assert.equal(l0.universe_passed, null)
  assert.equal(l0.liquidity_evidence_source, null)
  assert.equal(l0.median_daily_traded_value_twd, null)
  const gate = gateFor(l0)
  assert.equal(gate.liquidity_capacity_passed, null)
  assert.equal(gate.universe_passed, null)
  assert.equal(gate.hard_blocked, false)
  assert.equal(gate.ml_slate_allowed, true)
  assert(!gate.notes.includes('universe_dropped_at_l0'))
  assert.equal(gate.pending_buy_blocked, false)
  assert(gate.notes.includes('liquidity_capacity_evidence_unavailable'))
  assert(!gate.notes.includes('liquidity_capacity_blocked'))
})

test('scoring receipt supplies the capacity verdict when the universe row was capped away', () => {
  const l0 = layer0([scoringRow('2330', compactL05LiquidityCapacityReceipt(passingReceipt)), seedRow('2330')], '2330')
  assert.equal(l0.liquidity_capacity_passed, true)
  assert.equal(l0.liquidity_evidence_source, 'scoring_l05_receipt')
  assert.equal(l0.liquidity_policy_version, L05_LIQUIDITY_CAPACITY_POLICY.schema_version)
  assert.equal(l0.liquidity_policy_checksum, L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM)
  assert.equal(l0.liquidity_metric, L05_LIQUIDITY_CAPACITY_POLICY.metric)
  assert.equal(l0.liquidity_window_sessions, L05_LIQUIDITY_CAPACITY_POLICY.window_sessions)
  assert.equal(l0.median_daily_traded_value_twd, Math.round(passingReceipt.median_daily_traded_value_twd!))
  assert.equal(l0.universe_passed, null, 'universe decision itself is still unknown without its row')
  assert(l0.feature_groups.includes('price_volume_liquidity'))
  const gate = gateFor(l0)
  assert.equal(gate.hard_blocked, false)
  assert(gate.notes.includes('liquidity_capacity_passed'))
})

test('a real L0.5 failure on the universe row still hard-blocks', () => {
  const l0 = layer0([
    {
      symbol: '9999',
      stage: 'universe',
      decision: 'drop',
      reason_code: failingReceipt.reason_code,
      evidence: JSON.stringify({ ...failingReceipt }),
    },
  ], '9999')
  assert.equal(failingReceipt.passed, false)
  assert.equal(l0.liquidity_capacity_passed, false)
  assert.equal(l0.liquidity_evidence_source, 'universe')
  assert.equal(l0.universe_passed, false)
  const gate = gateFor(l0)
  assert.equal(gate.liquidity_capacity_passed, false)
  assert.equal(gate.hard_blocked, true)
  assert.equal(gate.pending_buy_blocked, true)
  assert(gate.notes.includes('liquidity_capacity_blocked'))
})

test('a failed scoring receipt hard-blocks; a universe row wins over the receipt', () => {
  const failed = layer0([scoringRow('1111', compactL05LiquidityCapacityReceipt(failingReceipt))], '1111')
  assert.equal(failed.liquidity_capacity_passed, false)
  assert.equal(gateFor(failed).hard_blocked, true)

  const both = layer0([
    {
      symbol: '2222',
      stage: 'universe',
      decision: 'pass',
      reason_code: 'l0_l05_capacity_passed',
      evidence: JSON.stringify({ close: 50, ...passingReceipt }),
    },
    scoringRow('2222', compactL05LiquidityCapacityReceipt(passingReceipt)),
  ], '2222')
  assert.equal(both.liquidity_evidence_source, 'universe')
  assert.equal(both.universe_passed, true)
  assert.equal(both.close, 50)
  assert.equal(both.mean_daily_traded_value_twd, passingReceipt.mean_daily_traded_value_twd)
})

test('universe drops decided before L0.5 carry no capacity verdict but still hard-block', () => {
  for (const [reason, evidence] of [
    ['hard_trading_restriction_block', { restricted: true, policy: 'hard_block' }],
    ['zero_volume', { volume: 0 }],
    ['price_out_of_range', { close: 3, minPrice: 5, maxPrice: 3000 }],
    ['insufficient_price_history', { price_row_count: 2, minimum_required_price_rows: 3 }],
  ] as const) {
    const l0 = layer0([
      { symbol: '3333', stage: 'universe', decision: 'drop', reason_code: reason, evidence: JSON.stringify(evidence) },
    ], '3333')
    assert.equal(l0.universe_passed, false, reason)
    assert.equal(l0.liquidity_capacity_passed, null, `${reason} never ran L0.5`)
    const gate = gateFor(l0)
    assert.equal(gate.liquidity_capacity_passed, null, reason)
    assert.equal(gate.universe_passed, false, reason)
    assert.equal(gate.hard_blocked, true, `${reason} must not read as a passed hard gate`)
    assert.equal(gate.pending_buy_blocked, true, reason)
    assert.equal(gate.ml_slate_allowed, false, reason)
    assert(gate.notes.includes('universe_dropped_at_l0'), reason)
    assert(gate.notes.includes('liquidity_capacity_evidence_unavailable'), reason)
  }
})

test('layer0 summary schema is v3 (tri-state universe/liquidity verdicts)', () => {
  const l0 = layer0([scoringRow('2330')], '2330')
  assert.equal(l0.schema_version, 'layer0_universe_features_summary_v3')
})

test('hard gate without universe evidence keeps the previous behaviour', () => {
  const gate = buildHardGateSummary({
    boardType: 'LISTED',
    tradabilityTier: 'auto_tradable',
    recommendationLane: 'tradable',
    eligibleForMl: true,
    eligibleForPendingBuy: true,
  })
  assert.equal(gate.universe_passed, null)
  assert.equal(gate.liquidity_capacity_passed, null)
  assert.equal(gate.hard_blocked, false)
  const passed = buildHardGateSummary({
    boardType: 'LISTED', tradabilityTier: 'auto_tradable', recommendationLane: 'tradable',
    eligibleForMl: true, eligibleForPendingBuy: true, universePassed: true, liquidityCapacityPassed: true,
  })
  assert.equal(passed.hard_blocked, false)
  assert(!passed.notes.includes('universe_dropped_at_l0'))
})

test('compact receipt is small, rounded and degrades to unknown when malformed', () => {
  const compact = compactL05LiquidityCapacityReceipt(passingReceipt)
  assert.equal(compact.passed, true)
  assert(Number.isInteger(compact.median_daily_traded_value_twd))
  assert(Number.isInteger(compact.mean_daily_traded_value_twd))
  // ~255 bytes vs ~558 for the full receipt; it rides on every scoring row.
  assert(JSON.stringify(compact).length < 300, `compact receipt grew to ${JSON.stringify(compact).length} bytes`)
  assert(JSON.stringify(compact).length < JSON.stringify(passingReceipt).length / 2)

  const foreign = expandL05LiquidityCapacityCompactReceipt({ ...compact, policy_checksum: `sha256:${'b'.repeat(64)}` })
  assert.equal(foreign?.passed, true)
  assert.equal(foreign?.policy_version, null, 'an unknown policy checksum must not borrow the current policy identity')
  assert.equal(foreign?.metric, null)

  assert.equal(expandL05LiquidityCapacityCompactReceipt(null), null)
  assert.equal(expandL05LiquidityCapacityCompactReceipt({ passed: 'true' }), null)
  assert.equal(expandL05LiquidityCapacityCompactReceipt([]), null)
})

test('capacity verdict survives the D1 persistence cap that truncates universe rows', () => {
  const symbols = Array.from({ length: 2600 }, (_, i) => String(1000 + i))
  const items = [
    ...symbols.map((symbol) => ({
      symbol,
      stage: 'universe',
      decision: 'pass' as const,
      reasonCode: 'l0_l05_capacity_passed',
      evidence: { close: 100, ...passingReceipt } as Record<string, unknown>,
    })),
    ...symbols.map((symbol) => ({
      symbol,
      stage: 'scoring',
      decision: 'pass' as const,
      reasonCode: 'base_score_computed',
      evidence: { l05_liquidity_capacity: compactL05LiquidityCapacityReceipt(passingReceipt) } as Record<string, unknown>,
    })),
  ]
  const persisted = selectScreenerFunnelItemsForPersistence(items)
  const persistedUniverse = new Set(persisted.filter((item) => item.stage === 'universe').map((item) => item.symbol))
  const capped = symbols.filter((symbol) => !persistedUniverse.has(symbol))
  assert(capped.length > 0, 'fixture must exercise universe truncation')

  const summaries = summarizeScreenerFunnelRows(persisted.map((item) => ({
    symbol: item.symbol,
    stage: item.stage,
    decision: item.decision,
    reason_code: item.reasonCode,
    evidence: JSON.stringify(item.evidence ?? {}),
  })))
  for (const symbol of [capped[0], capped[capped.length - 1]]) {
    const l0 = summaries.get(symbol)?.evidence.layer0_universe_features as Record<string, any>
    assert.equal(l0.liquidity_capacity_passed, true, `${symbol} lost its universe row but must not read as blocked`)
    assert.equal(gateFor(l0).hard_blocked, false)
  }
})

test('market screener writes the compact L0.5 receipt onto the always-persisted scoring row', () => {
  const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  assert(source.includes('l05_liquidity_capacity: compactL05LiquidityCapacityReceipt(liquidityCapacity)'))
  assert(source.includes('universe.push({ stockId, prices, liquidityCapacity })'))
  const evidence = readFileSync(new URL('./screenerFunnelEvidence.ts', import.meta.url), 'utf8')
  assert(!evidence.includes('liquidity_capacity_passed: universeEvidence.passed === true'),
    'a missing universe row must not collapse to a failed capacity gate')
})
