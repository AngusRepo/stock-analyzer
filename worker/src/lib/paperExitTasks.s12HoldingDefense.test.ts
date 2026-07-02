import { readFileSync } from 'node:fs'
import { resolveS12HoldingDefenseEventAction, resolveS12HoldingDefenseUpdate, shouldRecordS12HoldingDefenseEvent } from './paperExitTasks'
import type { S12IntradayAssessment } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperExitTasksSource = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
assert(
  paperExitTasksSource.includes('no_short_order: true') &&
  paperExitTasksSource.includes("execution_owner: 's12_position_decision_v1'") &&
  paperExitTasksSource.includes("fallback_exit_owner: 'paper_sltp_atr_trailing_v1'") &&
  paperExitTasksSource.includes('resolveS12PrimaryExitDecision') &&
  paperExitTasksSource.includes('s12_primary_independent_of_long_entry_readiness'),
  'S12 holding-defense telemetry must expose S12 as primary position-decision owner while preserving no-short and fallback owner boundaries',
)

function assessment(ready: boolean): S12IntradayAssessment {
  return {
    state: ready ? 'bearish_defense_ready' : 'waiting_15m_zone_touch',
    reason: ready ? 's12_bearish_defense_ready' : 's12_waiting_15m_zone_touch',
    setupId: ready ? 's12l-test' : null,
    maturity: {
      takeoverEligible: ready,
      takeoverRole: ready ? 'no_buy_defense' : 'none',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: ready ? 'bearish_defense_ready' : 'waiting_15m_zone_touch',
      stage: ready ? 'defensive' : 'setup',
    },
    exitPlan: {
      tp1: { price: null, source: 'unavailable', action: 'partial_take_profit' },
      mainExit: { price: null, zoneLow: null, zoneHigh: null, source: 'unavailable', action: 'main_take_profit' },
      trailingStop: { initial: null, method: 'structure_stop_then_15m_higher_low_atr_vwap', activation: 'after_tp1_or_reverse_choch' },
      reverseWarning: { state: ready ? 'bearish_defense_ready' : 'waiting_supply_zone_touch', action: ready ? 'EXIT_ON_REVERSE_BOS' : 'none', source: 'bearish_defense_sidecar' },
    },
    bearishDefense: {
      ready,
      state: ready ? 'bearish_defense_ready' : 'waiting_supply_zone_touch',
    },
  } as S12IntradayAssessment
}

const noSignal = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
  },
  currentPrice: 102,
  atr14: 2,
  assessment: assessment(false),
})
assert(noSignal == null, 'non-bearish S12 assessment should not alter holding defense')

const tightened = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
  },
  currentPrice: 103,
  atr14: 2,
  assessment: assessment(true),
})
assert(tightened?.action === 'hold', 'S12 holding defense must stay hold/update only')
assert((tightened?.newTrailingStop ?? 0) > 94, 'S12 bearish defense should raise trailing stop')
assert((tightened?.newTrailingStop ?? 999) < 103, 'S12 trailing update should stay below current price')
assert(String(tightened?.reason ?? '').includes('tighten_stop'), 'S12 bearish defense should explain defensive action')
assert(
  resolveS12HoldingDefenseEventAction(tightened?.reason) === 'take_profit_or_tighten_stop',
  'profitable S12 bearish defense should surface take-profit-or-tighten advisory action',
)

const trimAdvisory = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 98,
    highest_since_entry: 105,
    tp1_hit: 0,
  },
  currentPrice: 105,
  atr14: 2,
  assessment: assessment(true),
})
assert(trimAdvisory?.action === 'partial_sell', 'S12 high-profit bearish defense should become a primary partial sell when book is executable')
assert(trimAdvisory?.sellShares === 1000, 'S12 partial sell should use configured 50% lot-rounded shares')
assert(
  resolveS12HoldingDefenseEventAction(trimAdvisory?.reason) === 'take_profit',
  'high-profit S12 bearish defense should surface executable take-profit action',
)

const defensiveOnly = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 90,
    highest_since_entry: 100,
    tp1_hit: 0,
  },
  currentPrice: 100.8,
  atr14: 2,
  assessment: assessment(true),
})
assert(defensiveOnly?.action === 'hold', 'S12 defensive-only update must remain hold/update')
assert(
  resolveS12HoldingDefenseEventAction(defensiveOnly?.reason) === 'tighten_stop',
  'non-profit S12 bearish defense should surface tighten-stop advisory action',
)

const alreadyTight = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 102.8,
    highest_since_entry: 103,
    tp1_hit: 1,
  },
  currentPrice: 103,
  atr14: 2,
  assessment: assessment(true),
})
assert(alreadyTight == null, 'S12 holding defense should not churn when trailing stop is already tight')

const tp1Partial = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 96,
    highest_since_entry: 103,
    tp1_price: 104,
    tp2_price: 110,
    tp1_hit: 0,
  },
  currentPrice: 104.5,
  atr14: 2,
  assessment: assessment(false),
  executableBookAvailable: true,
})
assert(tp1Partial?.action === 'partial_sell', 'S12 position decision should trigger persisted TP1 partial sell')
assert(tp1Partial?.sellShares === 1000, 'S12 TP1 should sell lot-rounded 50% of original shares')

const tp1BlockedByQuote = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 96,
    highest_since_entry: 103,
    tp1_price: 104,
    tp2_price: 110,
    tp1_hit: 0,
  },
  currentPrice: 104.5,
  atr14: 2,
  assessment: assessment(false),
  executableBookAvailable: false,
})
assert(tp1BlockedByQuote == null, 'S12 sell action must fail closed when executable orderbook is unavailable')

const nowMs = Date.UTC(2026, 5, 30, 3, 0, 0)
const recentObserve = {
  status: 'waiting_15m_zone_touch',
  reason: 's12_waiting_15m_zone_touch',
  created_at: new Date(nowMs - 60_000).toISOString(),
  detail_json: JSON.stringify({ holding_defense: { active: false, action: 'observe' } }),
}
assert(
  shouldRecordS12HoldingDefenseEvent({
    latest: recentObserve,
    nextStatus: 'waiting_15m_zone_touch',
    nextReason: 's12_waiting_15m_zone_touch',
    nextActive: false,
    nextTrailingAfter: null,
    nowMs,
    minIntervalMs: 10 * 60_000,
  }) === false,
  'S12 holding-defense observe events should be throttled when unchanged',
)
assert(
  shouldRecordS12HoldingDefenseEvent({
    latest: recentObserve,
    nextStatus: 'bearish_defense_ready',
    nextReason: 'S12 bearish defense TIGHTEN_STOP @ 101.40',
    nextActive: true,
    nextTrailingAfter: 101.4,
    nowMs,
    minIntervalMs: 10 * 60_000,
  }) === true,
  'S12 holding-defense should record active defensive state changes immediately',
)
const recentActive = {
  status: 'bearish_defense_ready',
  reason: 'S12 bearish defense TIGHTEN_STOP @ 101.40',
  created_at: new Date(nowMs - 60_000).toISOString(),
  detail_json: JSON.stringify({ holding_defense: { active: true, trailing_stop_after: 101.4 } }),
}
assert(
  shouldRecordS12HoldingDefenseEvent({
    latest: recentActive,
    nextStatus: 'bearish_defense_ready',
    nextReason: 'S12 bearish defense TIGHTEN_STOP @ 101.80',
    nextActive: true,
    nextTrailingAfter: 101.8,
    nowMs,
    minIntervalMs: 10 * 60_000,
  }) === true,
  'S12 holding-defense should record changed trailing stop immediately',
)
assert(
  shouldRecordS12HoldingDefenseEvent({
    latest: { ...recentObserve, created_at: new Date(nowMs - 20 * 60_000).toISOString() },
    nextStatus: 'waiting_15m_zone_touch',
    nextReason: 's12_waiting_15m_zone_touch',
    nextActive: false,
    nextTrailingAfter: null,
    nowMs,
    minIntervalMs: 10 * 60_000,
  }) === true,
  'S12 holding-defense should refresh unchanged observe events after throttle window',
)
