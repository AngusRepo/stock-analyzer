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
assert(
  paperExitTasksSource.includes('updateLifecycleS12TrailingStop') &&
    paperExitTasksSource.includes('trade_lifecycle_json=COALESCE(?, trade_lifecycle_json)') &&
    paperExitTasksSource.includes('resolveEffectiveS12PositionStop(pos, entryPx)'),
  'S12 position updates and partial exits must persist the active structural stop back to canonical trade lifecycle',
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

const structuralStopWatch = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
    s12_position_stop_price: 97,
    s12_position_stop_source: '15m_recent_fvg',
    s12_position_stop_method: '15m_recent_bullish_fvg',
  },
  currentPrice: 102,
  atr14: 2,
  assessment: assessment(false),
})
assert(structuralStopWatch?.action === 'hold', 'S12 position stop should own holding defense even before bearish-defense readiness')
assert(structuralStopWatch?.newTrailingStop === 97, 'S12 position stop should set the structural 15m no-ATR stop')
assert(String(structuralStopWatch?.reason ?? '').includes('s12_position_structural_stop_watch'), 'S12 position stop watch reason should be explicit')

const structuralStopExit = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
    s12_position_stop_price: 97,
    s12_position_stop_source: '15m_recent_fvg',
    s12_position_stop_method: '15m_recent_bullish_fvg',
  },
  currentPrice: 96.8,
  atr14: 2,
  assessment: assessment(false),
  executableBookAvailable: true,
})
assert(structuralStopExit?.action === 'full_sell', 'S12 position structural stop touch should trigger a primary full exit')
assert(String(structuralStopExit?.reason ?? '').includes('s12_position_structural_stop_full_exit'), 'S12 structural stop exit reason should be explicit')

const lifecycleStopWatch = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
    trade_lifecycle_json: JSON.stringify({
      version: 'canonical_trade_lifecycle_v1',
      entry: {
        stopLoss: 96,
        s12: {
          structureStop: 96,
          exitPlan: {
            tp1: 108,
            mainExit: 118,
            tp3: 126,
            tp4: 134,
            plannedTakeProfit: 'tp4',
            trailingInitial: 97,
            trailingSource: '15m_recent_fvg',
            trailingMethod: '15m_recent_bullish_fvg',
          },
        },
      },
    }),
  },
  currentPrice: 102,
  atr14: 2,
  assessment: assessment(false),
})
assert(lifecycleStopWatch?.action === 'hold', 'S12 lifecycle stop should survive market-open incomplete 15m structure')
assert(lifecycleStopWatch?.newTrailingStop === 97, 'S12 lifecycle stop should be restored instead of falling back to ATR trailing')
assert(String(lifecycleStopWatch?.reason ?? '').includes('s12_position_structural_stop_watch'), 'restored lifecycle S12 stop should keep structural-stop reason')

const exitFusionRaisesAssessmentStop = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 1000,
    original_shares: 1000,
    avg_cost: 141.7,
    entry_price: 141.5,
    initial_stop: 117.75,
    trailing_stop: 123,
    highest_since_entry: 144,
    tp1_price: 175.46,
    tp2_price: 209.43,
    tp1_hit: 0,
    s12_position_stop_price: 123,
    s12_position_stop_source: 'paper_sltp_atr_trailing_v1',
    s12_position_stop_method: 'atr_trailing_fallback',
  },
  currentPrice: 143.5,
  atr14: 4,
  assessment: {
    ...assessment(false),
    state: 'limited_takeover_ready',
    reason: 's12_limited_takeover_ready',
    setupId: 's12l-fusion',
    maturity: {
      takeoverEligible: true,
      takeoverRole: 'long_entry',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: 'limited_takeover_ready',
      stage: 'ready',
    },
    exitPlan: {
      mode: 'structure_first_trailing_v1',
      tp1: { price: 144, source: 'vwap_fair_value', action: 'partial_take_profit' },
      mainExit: { price: 144.5, zoneLow: 144, zoneHigh: 145, source: 'vwap_fair_value', action: 'main_take_profit' },
      tp3: { price: 145, source: 'vwap_fair_value', action: 'extended_take_profit' },
      tp4: { price: 145.5, source: 'vwap_fair_value', action: 'extended_take_profit' },
      manualTp: { price: null, source: 'unavailable', action: 'manual_take_profit' },
      trailingStop: { initial: 142.5, source: '15m_recent_fvg', method: '15m_recent_bullish_fvg', activation: 'after_tp1_or_reverse_choch' },
      reverseWarning: { state: 'waiting_supply_zone_touch', action: 'none', source: 'bearish_defense_sidecar' },
    },
    execution: { entryPrice: 143.5, stopLoss: 142.5 },
    quality: {
      vwap: { value: 144.33, priceVsVwapPct: -0.58, state: 'below' },
      vwapContext: {
        schemaVersion: 's12_vwap_context_v1',
        session: { value: 144.33, priceVsPct: -0.58, state: 'below', bars: 16 },
        h1: { value: 143.47, priceVsPct: 0.02, state: 'above', bars: 4 },
        h4: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        daily: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        anchored: {
          day: { value: 144.33, priceVsPct: -0.58, state: 'below', bars: 16 },
          week: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          month: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          quarter: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          year: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        },
        rolling15m: {
          bars7: { value: 143.7, priceVsPct: -0.14, state: 'below', bars: 7 },
          bars30: { value: null, priceVsPct: null, state: 'unavailable', bars: 16 },
          bars90: { value: null, priceVsPct: null, state: 'unavailable', bars: 16 },
        },
        rollingDays: {
          days7: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days30: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days90: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days365: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        },
        previousZones: { h1: null, h4: null, daily: null },
        previousPeriodZones: { day: null, week: null, month: null, quarter: null, year: null },
        initialBalance: { high: 145, low: 143.8, state: 'below', bars: 4 },
        stackState: 'mixed',
        confluenceWidthPct: null,
        nearestAbove: { price: 144.33, source: 'session_vwap', distancePct: 0.58 },
        nearestBelow: { price: 143.47, source: 'h1_vwap', distancePct: 0.02 },
      },
      rvol: { value: 0.3235, state: 'thin', lookbackBars: 20 },
      notes: [],
    },
  } as S12IntradayAssessment,
})
assert(exitFusionRaisesAssessmentStop?.action === 'hold', 'S12/VWAP exit fusion should raise defense stop without forcing a sell')
assert(exitFusionRaisesAssessmentStop?.newTrailingStop === 142.5, 'S12/VWAP exit fusion should use the newer assessment structural stop above ATR fallback')
assert(String(exitFusionRaisesAssessmentStop?.reason ?? '').includes('exit_fusion'), 'S12/VWAP exit fusion should be visible in holding-defense reason')
assert(
  resolveS12HoldingDefenseEventAction(exitFusionRaisesAssessmentStop?.reason) === 'tighten_stop',
  'S12/VWAP exit fusion should surface as tighten-stop, not take-profit',
)

const takeProfitFusionStructuralTp1 = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 1000,
    original_shares: 1000,
    avg_cost: 141.7,
    entry_price: 141.5,
    initial_stop: 117.75,
    trailing_stop: 123,
    highest_since_entry: 144.5,
    tp1_price: 175.46,
    tp2_price: 209.43,
    tp1_hit: 0,
    s12_position_stop_price: 123,
    s12_position_stop_source: 'paper_sltp_atr_trailing_v1',
    s12_position_stop_method: 'atr_trailing_fallback',
  },
  currentPrice: 144.2,
  atr14: 4,
  assessment: {
    ...assessment(false),
    state: 'limited_takeover_ready',
    reason: 's12_limited_takeover_ready',
    setupId: 's12l-fusion-tp',
    maturity: {
      takeoverEligible: true,
      takeoverRole: 'long_entry',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: 'limited_takeover_ready',
      stage: 'ready',
    },
    exitPlan: {
      mode: 'structure_first_trailing_v1',
      tp1: { price: 144, source: 'vwap_fair_value', action: 'partial_take_profit' },
      mainExit: { price: 144.5, zoneLow: 144, zoneHigh: 145, source: 'vwap_fair_value', action: 'main_take_profit' },
      tp3: { price: 145, source: 'vwap_fair_value', action: 'extended_take_profit' },
      tp4: { price: 145.5, source: 'vwap_fair_value', action: 'extended_take_profit' },
      manualTp: { price: null, source: 'unavailable', action: 'manual_take_profit' },
      trailingStop: { initial: 142.5, source: '15m_recent_fvg', method: '15m_recent_bullish_fvg', activation: 'after_tp1_or_reverse_choch' },
      reverseWarning: { state: 'waiting_supply_zone_touch', action: 'none', source: 'bearish_defense_sidecar' },
    },
    execution: { entryPrice: 143.5, stopLoss: 142.5 },
    quality: {
      vwap: { value: 144.33, priceVsVwapPct: -0.09, state: 'below' },
      vwapContext: {
        schemaVersion: 's12_vwap_context_v1',
        session: { value: 144.33, priceVsPct: -0.09, state: 'below', bars: 16 },
        h1: { value: 143.47, priceVsPct: 0.51, state: 'above', bars: 4 },
        h4: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        daily: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        anchored: {
          day: { value: 144.33, priceVsPct: -0.09, state: 'below', bars: 16 },
          week: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          month: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          quarter: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          year: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        },
        rolling15m: {
          bars7: { value: 143.7, priceVsPct: 0.35, state: 'above', bars: 7 },
          bars30: { value: null, priceVsPct: null, state: 'unavailable', bars: 16 },
          bars90: { value: null, priceVsPct: null, state: 'unavailable', bars: 16 },
        },
        rollingDays: {
          days7: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days30: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days90: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days365: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        },
        previousZones: { h1: null, h4: null, daily: null },
        previousPeriodZones: { day: null, week: null, month: null, quarter: null, year: null },
        initialBalance: { high: 145, low: 143.8, state: 'inside', bars: 4 },
        stackState: 'mixed',
        confluenceWidthPct: null,
        nearestAbove: { price: 144.33, source: 'session_vwap', distancePct: 0.09 },
        nearestBelow: { price: 143.47, source: 'h1_vwap', distancePct: 0.51 },
      },
      rvol: { value: 0.75, state: 'thin', lookbackBars: 20 },
      notes: [],
    },
  } as S12IntradayAssessment,
})
assert(takeProfitFusionStructuralTp1?.action === 'partial_sell', 'S12 TP fusion should trim at structural TP1 before far ATR TP1')
assert(takeProfitFusionStructuralTp1?.sellShares === 500, 'S12 TP fusion should keep the lifecycle runner after structural TP1 trim')
assert(String(takeProfitFusionStructuralTp1?.reason ?? '').includes('tp_fusion'), 'S12 TP fusion reason should be explicit')

const sameDayFifteenMinuteHighOnly = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 331,
    original_shares: 331,
    avg_cost: 137.7,
    entry_price: 137.5,
    initial_stop: 135.5,
    trailing_stop: 135.5,
    highest_since_entry: 138.5,
    tp1_price: 138,
    tp2_price: 141.5,
    tp1_hit: 0,
    s12_position_stop_price: 135.5,
    s12_position_stop_source: '15m_protected_low',
    s12_position_stop_method: '15m_protected_low',
    s12_tp1_source: '15m_previous_high',
    s12_main_exit_source: 'tp_ladder',
    position_opened_today: true,
  },
  currentPrice: 138.5,
  atr14: 3.5,
  assessment: {
    ...assessment(false),
    state: 'limited_takeover_ready',
    reason: 's12_limited_takeover_ready',
    setupId: 's12l-2441-like',
    maturity: {
      takeoverEligible: true,
      takeoverRole: 'long_entry',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: 'limited_takeover_ready',
      stage: 'ready',
    },
    exitPlan: {
      mode: 'structure_first_trailing_v1',
      tp1: { price: 138, source: '15m_previous_high', action: 'partial_take_profit' },
      mainExit: { price: 141.5, zoneLow: 141, zoneHigh: 142, source: 'tp_ladder', action: 'main_take_profit' },
      tp3: { price: 144, source: 'tp_ladder', action: 'extended_take_profit' },
      tp4: { price: 146, source: 'tp_ladder', action: 'extended_take_profit' },
      manualTp: { price: null, source: 'unavailable', action: 'manual_take_profit' },
      trailingStop: { initial: 135.5, source: '15m_protected_low', method: '15m_protected_low', activation: 'after_tp1_or_reverse_choch' },
      reverseWarning: { state: 'waiting_supply_zone_touch', action: 'none', source: 'bearish_defense_sidecar' },
    },
    execution: { entryPrice: 137.5, stopLoss: 135.5 },
    quality: {
      vwap: { value: 138.1, priceVsVwapPct: 0.29, state: 'above' },
      vwapContext: {
        schemaVersion: 's12_vwap_context_v1',
        session: { value: 138.1, priceVsPct: 0.29, state: 'above', bars: 8 },
        h1: { value: 137.9, priceVsPct: 0.44, state: 'above', bars: 2 },
        h4: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        daily: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        anchored: {
          day: { value: 138.1, priceVsPct: 0.29, state: 'above', bars: 8 },
          week: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          month: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          quarter: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          year: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        },
        rolling15m: {
          bars7: { value: 138, priceVsPct: 0.36, state: 'above', bars: 7 },
          bars30: { value: null, priceVsPct: null, state: 'unavailable', bars: 8 },
          bars90: { value: null, priceVsPct: null, state: 'unavailable', bars: 8 },
        },
        rollingDays: {
          days7: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days30: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days90: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
          days365: { value: null, priceVsPct: null, state: 'unavailable', bars: 0 },
        },
        previousZones: { h1: null, h4: null, daily: null },
        previousPeriodZones: { day: null, week: null, month: null, quarter: null, year: null },
        initialBalance: { high: 138.6, low: 137.2, state: 'inside', bars: 4 },
        stackState: 'bullish_stack',
        confluenceWidthPct: null,
        nearestAbove: null,
        nearestBelow: { price: 138.1, source: 'session_vwap', distancePct: 0.29 },
      },
      rvol: { value: 0.7, state: 'thin', lookbackBars: 20 },
      notes: [],
    },
  } as S12IntradayAssessment,
})
assert(sameDayFifteenMinuteHighOnly?.action === 'hold', 'same-day 15m-high-only TP pressure must not trigger a partial sell')
assert(sameDayFifteenMinuteHighOnly?.sellShares == null, 'same-day 15m-high-only TP pressure should keep all shares')
assert(!String(sameDayFifteenMinuteHighOnly?.reason ?? '').includes('take_profit'), '15m-high-only pressure should not be labeled as take profit')

const lifecycleStopExit = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
    trade_lifecycle_json: JSON.stringify({
      version: 'canonical_trade_lifecycle_v1',
      entry: {
        stopLoss: 96,
        s12: {
          structureStop: 96,
          exitPlan: {
            trailingInitial: 97,
            trailingSource: '15m_recent_fvg',
            trailingMethod: '15m_recent_bullish_fvg',
          },
        },
      },
    }),
  },
  currentPrice: 96.9,
  atr14: 2,
  assessment: assessment(false),
  executableBookAvailable: true,
})
assert(lifecycleStopExit?.action === 'full_sell', 'S12 lifecycle stop breach should trigger primary structural exit')
assert(String(lifecycleStopExit?.reason ?? '').includes('s12_position_structural_stop_full_exit'), 'S12 lifecycle stop breach should not become ATR fallback')

const structuralProfitStopExit = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 101,
    highest_since_entry: 110,
    tp1_hit: 1,
    s12_position_stop_price: 103,
    s12_position_stop_source: '15m_recent_fvg',
    s12_position_stop_method: '15m_recent_bullish_fvg',
  },
  currentPrice: 102.9,
  atr14: 2,
  assessment: assessment(false),
  executableBookAvailable: true,
})
assert(structuralProfitStopExit?.action === 'full_sell', 'S12 structural trailing stop above entry should protect profit on pullback')
assert(String(structuralProfitStopExit?.reason ?? '').includes('s12_position_structural_stop_full_exit'), 'S12 profit-stop exit reason should stay structural')

const lowerTimeframeWeakTightened = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 103,
    tp1_hit: 0,
    s12_position_stop_price: 101.5,
    s12_position_stop_source: '15m_recent_fvg',
    s12_position_stop_method: '15m_recent_bullish_fvg',
  },
  currentPrice: 103,
  atr14: 2,
  assessment: assessment(true),
})
assert(lowerTimeframeWeakTightened?.action === 'hold', 'S12 lower-timeframe bearish defense should tighten stop instead of selling by itself')
assert(String(lowerTimeframeWeakTightened?.reason ?? '').includes('tighten_stop'), 'S12 lower-timeframe weakness should explain tighten-stop defense')
assert(
  resolveS12HoldingDefenseEventAction(lowerTimeframeWeakTightened?.reason) === 'tighten_stop',
  'S12 lower-timeframe weakness should surface tighten-stop advisory action',
)

const htfBearishExit = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 99,
    highest_since_entry: 106,
    tp1_hit: 1,
  },
  currentPrice: 103,
  atr14: 2,
  assessment: {
    ...assessment(false),
    bias4h: { direction: 'short', confidence: 'confirmed', channelAlign: false },
    barDiagnostics: { channel_1d_direction: 'short' },
  } as S12IntradayAssessment,
  executableBookAvailable: true,
})
assert(htfBearishExit?.action === 'full_sell', 'S12 should full-exit only when Daily and 4H bearish regime confirm profit protection')
assert(String(htfBearishExit?.reason ?? '').includes('s12_daily_4h_bearish_profit_protect_full_exit'), 'S12 HTF bearish full-exit reason should be explicit')

const tightened = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 2000,
    original_shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 92,
    trailing_stop: 94,
    highest_since_entry: 100.5,
    tp1_hit: 0,
    s12_position_stop_price: 99.2,
    s12_position_stop_source: '15m_recent_order_block',
    s12_position_stop_method: '15m_recent_bullish_order_block',
  },
  currentPrice: 100.5,
  atr14: 2,
  assessment: assessment(true),
})
assert(tightened?.action === 'hold', 'S12 holding defense must stay hold/update only')
assert((tightened?.newTrailingStop ?? 0) > 94, 'S12 bearish defense should raise trailing stop')
assert((tightened?.newTrailingStop ?? 999) < 103, 'S12 trailing update should stay below current price')
assert(String(tightened?.reason ?? '').includes('tighten_stop'), 'S12 bearish defense should explain defensive action')
assert(
  resolveS12HoldingDefenseEventAction(tightened?.reason) === 'tighten_stop',
  'S12 bearish defense stop update should surface tighten-stop advisory action',
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
    s12_position_stop_price: 103.5,
    s12_position_stop_source: '15m_recent_fvg',
    s12_position_stop_method: '15m_recent_bullish_fvg',
  },
  currentPrice: 105,
  atr14: 2,
  assessment: assessment(true),
})
assert(trimAdvisory?.action === 'hold', 'S12 high-profit lower-timeframe bearish defense should tighten stop, not sell without HTF confirmation')
assert(
  resolveS12HoldingDefenseEventAction(trimAdvisory?.reason) === 'tighten_stop',
  'high-profit lower-timeframe S12 bearish defense should surface tighten-stop action',
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
    s12_position_stop_price: 98.5,
    s12_position_stop_source: '15m_recent_fvg',
    s12_position_stop_method: '15m_recent_bullish_fvg',
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
  currentPrice: 100.8,
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

const tp1OddLotPartial = resolveS12HoldingDefenseUpdate({
  pos: {
    shares: 331,
    original_shares: 331,
    avg_cost: 137.7,
    entry_price: 137.5,
    initial_stop: 135.5,
    trailing_stop: 135.5,
    highest_since_entry: 138.5,
    tp1_price: 138,
    tp2_price: 141.5,
    tp1_hit: 0,
  },
  currentPrice: 138.5,
  atr14: 8.78,
  assessment: assessment(false),
  executableBookAvailable: true,
})
assert(tp1OddLotPartial?.action === 'partial_sell', 'S12 TP1 should support odd-lot partial sell instead of forcing full exit')
assert(tp1OddLotPartial?.sellShares === 165, 'S12 odd-lot TP1 should sell floor(331 * 50%) shares and keep a runner')

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
