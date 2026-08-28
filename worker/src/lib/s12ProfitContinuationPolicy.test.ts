import assert from 'node:assert/strict'
import {
  resolveS12ProfitContinuationPolicy,
  type PromotedS12ProfitContinuationPolicy,
} from './s12ProfitContinuationPolicy'

const policy: PromotedS12ProfitContinuationPolicy = {
  artifactId: 's12-profit-continuation-v1-2026-08-28',
  payloadChecksum: 'a'.repeat(64),
  knowledgeCutoffDate: '2026-08-14',
  payload: {
    schema_version: 's12-profit-continuation-serving-artifact-v1',
    contract: 's12-profit-continuation-v1',
    enabled: true,
    scope: 'paper_only',
    real_order_effect: false,
    maximum_continuation_minutes: 60,
    final_tranche_only: true,
    no_overnight: true,
    rank_or_top_k_used: false,
    incremental_transaction_cost_bps: 0,
    safety_priority: [
      'active_structure_stop',
      'bearish_defense_or_reverse_bos',
      'profit_continuation_deadline',
    ],
    evidence: {
      receipt_checksum: 'b'.repeat(64),
      full_cohort_checksum: 'c'.repeat(64),
      paired_rows_checksum: 'd'.repeat(64),
      validation_start: '2026-06-05',
      validation_end: '2026-08-14',
      sample_count: 3749,
      date_count: 42,
      changed_rows: 221,
      full_portfolio_delta_lcb90: 0.000099923045,
      bootstrap_mean_delta_q05: 0.000082241773,
      trade_cvar10_non_degradation: true,
      date_cvar10_non_degradation: true,
      drawdown_non_degradation: true,
    },
  },
}

const position = {
  shares: 1000,
  original_shares: 2000,
  tp1_hit: 1,
  trailing_stop: 104,
  trade_lifecycle_json: '{}',
}
const finalTakeProfit = {
  action: 'full_sell' as const,
  reason: 's12_tp3_extended_take_profit',
  exitIntentKind: 'take_profit' as const,
  newTrailingStop: 110,
}

const activated = resolveS12ProfitContinuationPolicy({
  policy,
  baseDecision: finalTakeProfit,
  position,
  tradeDate: '2026-08-28',
  nowMs: 1_000_000,
  allowActivation: true,
})
assert.equal(activated.state, 'activated')
assert.equal(activated.decision.action, 'hold')
assert.equal(activated.decision.newTrailingStop, 110)
assert(activated.lifecycleJson?.includes(policy.artifactId))

const activePosition = { ...position, trade_lifecycle_json: activated.lifecycleJson }
const continuing = resolveS12ProfitContinuationPolicy({
  policy,
  baseDecision: finalTakeProfit,
  position: activePosition,
  tradeDate: '2026-08-28',
  nowMs: 1_000_000 + 30 * 60_000,
  allowActivation: true,
})
assert.equal(continuing.state, 'continuing')
assert.equal(continuing.decision.action, 'hold')

const safety = resolveS12ProfitContinuationPolicy({
  policy,
  baseDecision: { action: 'full_sell', reason: 's12_position_structural_stop_full_exit', exitIntentKind: 'risk_stop' },
  position: activePosition,
  tradeDate: '2026-08-28',
  nowMs: 1_000_000 + 40 * 60_000,
  allowActivation: true,
})
assert.equal(safety.state, 'safety_exit')
assert.equal(safety.decision.exitIntentKind, 'risk_stop')

const deadline = resolveS12ProfitContinuationPolicy({
  policy,
  baseDecision: finalTakeProfit,
  position: activePosition,
  tradeDate: '2026-08-28',
  nowMs: 1_000_000 + 60 * 60_000,
  allowActivation: true,
})
assert.equal(deadline.state, 'deadline_exit')
assert.equal(deadline.decision.action, 'full_sell')

const nextSession = resolveS12ProfitContinuationPolicy({
  policy,
  baseDecision: finalTakeProfit,
  position: activePosition,
  tradeDate: '2026-08-29',
  nowMs: 1_000_000 + 10 * 60_000,
  allowActivation: true,
})
assert.equal(nextSession.state, 'session_close_exit')

const eodNoActivation = resolveS12ProfitContinuationPolicy({
  policy,
  baseDecision: finalTakeProfit,
  position,
  tradeDate: '2026-08-28',
  nowMs: 1_000_000,
  allowActivation: false,
})
assert.equal(eodNoActivation.state, 'inactive')
assert.equal(eodNoActivation.decision.action, 'full_sell')

console.log('S12 profit continuation policy tests passed')
