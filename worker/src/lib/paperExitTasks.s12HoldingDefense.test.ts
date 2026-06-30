import { readFileSync } from 'node:fs'
import { resolveS12HoldingDefenseEventAction, resolveS12HoldingDefenseUpdate, shouldRecordS12HoldingDefenseEvent } from './paperExitTasks'
import type { S12IntradayAssessment } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperExitTasksSource = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
assert(
  paperExitTasksSource.includes('no_short_order: true') &&
  paperExitTasksSource.includes('advisory_only: true') &&
  paperExitTasksSource.includes("execution_owner: 'paper_sltp_atr_trailing_v1'"),
  'S12 holding-defense telemetry must preserve advisory-only, no-short, and existing exit-owner boundaries',
)

function assessment(ready: boolean): S12IntradayAssessment {
  return {
    state: ready ? 'bearish_defense_ready' : 'waiting_15m_zone_touch',
    bearishDefense: {
      ready,
      state: ready ? 'bearish_defense_ready' : 'waiting_supply_zone_touch',
    },
  } as S12IntradayAssessment
}

const noSignal = resolveS12HoldingDefenseUpdate({
  pos: {
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
assert(String(tightened?.reason ?? '').includes('TIGHTEN_STOP'), 'S12 bearish defense should explain defensive action')
assert(
  resolveS12HoldingDefenseEventAction(tightened?.reason) === 'take_profit_or_tighten_stop',
  'profitable S12 bearish defense should surface take-profit-or-tighten advisory action',
)

const trimAdvisory = resolveS12HoldingDefenseUpdate({
  pos: {
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
assert(trimAdvisory?.action === 'hold', 'S12 trim advisory must not become an automatic partial sell')
assert(
  resolveS12HoldingDefenseEventAction(trimAdvisory?.reason) === 'trim_or_take_profit',
  'high-profit S12 bearish defense should surface trim-or-take-profit advisory action',
)

const defensiveOnly = resolveS12HoldingDefenseUpdate({
  pos: {
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
