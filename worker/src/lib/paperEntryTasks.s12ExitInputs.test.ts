import { resolveS12AssistedExitInputs } from './paperEntryTasks'
import type { S12IntradayAssessment } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assessment(exitPlan: Partial<S12IntradayAssessment['exitPlan']>, execution: Partial<S12IntradayAssessment['execution']> = {}): S12IntradayAssessment {
  return {
    exitPlan: {
      tp1: { price: null, source: 'unavailable', action: 'partial_take_profit' },
      mainExit: { price: null, zoneLow: null, zoneHigh: null, source: 'unavailable', action: 'main_take_profit' },
      trailingStop: { initial: null, method: 'structure_stop_then_15m_higher_low_atr_vwap', activation: 'after_tp1_or_reverse_choch' },
      reverseWarning: { state: null, action: 'none', source: 'bearish_defense_sidecar' },
      ...exitPlan,
    },
    execution,
  } as S12IntradayAssessment
}

const structural = resolveS12AssistedExitInputs({
  fillPrice: 100,
  s12AssistApplied: true,
  s12Assessment: assessment({
    tp1: { price: 108, source: '15m_previous_high', action: 'partial_take_profit' },
    mainExit: { price: 118, zoneLow: 116, zoneHigh: 120, source: '1h_supply_zone', action: 'main_take_profit' },
    trailingStop: { initial: 94, method: 'structure_stop_then_15m_higher_low_atr_vwap', activation: 'after_tp1_or_reverse_choch' },
  }),
  atrInitialStop: 92,
  atrTp1: 106,
  atrTp2: 112,
})
assert(structural.source === 's12_structure_exit_plan', 'S12 assist should mark structure exit source')
assert(structural.initialStop === 94, 'S12 assist should use structural initial stop')
assert(structural.tp1 === 108, 'S12 assist should use structural TP1')
assert(structural.tp2 === 118, 'S12 assist should use structural main exit as TP2')

const fallback = resolveS12AssistedExitInputs({
  fillPrice: 100,
  s12AssistApplied: true,
  s12Assessment: assessment({
    tp1: { price: 98, source: '15m_previous_high', action: 'partial_take_profit' },
    mainExit: { price: 99, zoneLow: 98, zoneHigh: 100, source: '1h_supply_zone', action: 'main_take_profit' },
    trailingStop: { initial: 103, method: 'structure_stop_then_15m_higher_low_atr_vwap', activation: 'after_tp1_or_reverse_choch' },
  }, { stopLoss: 104 }),
  atrInitialStop: 92,
  atrTp1: 106,
  atrTp2: 112,
})
assert(fallback.initialStop === 92, 'invalid structural stop should fall back to ATR stop')
assert(fallback.tp1 === 106, 'invalid structural TP1 should fall back to ATR TP1')
assert(fallback.tp2 === 112, 'invalid structural main exit should fall back to ATR TP2')

const disabled = resolveS12AssistedExitInputs({
  fillPrice: 100,
  s12AssistApplied: false,
  s12Assessment: structural as unknown as S12IntradayAssessment,
  atrInitialStop: 92,
  atrTp1: 106,
  atrTp2: 112,
})
assert(disabled.source === 'sltp_atr_default', 'non-S12 fills should keep ATR default source')
assert(disabled.initialStop === 92 && disabled.tp1 === 106 && disabled.tp2 === 112, 'non-S12 fills should keep ATR defaults')
