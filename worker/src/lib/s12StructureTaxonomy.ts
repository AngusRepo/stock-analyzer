import type { S12IntradayAssessment } from './s12IntradayStructure'

export type S12StructureClass =
  | 'execution_ready'
  | 'setup_waiting'
  | 'risk_blocked'
  | 'invalidated'
  | 'unavailable'

const EXECUTION_READY_STATES = new Set([
  'reaction_ready',
  'limited_takeover_ready',
])

const RISK_BLOCKED_STATES = new Set([
  'waiting_session_60m_bearish_risk',
  'bearish_defense_ready',
])

const UNAVAILABLE_STATES = new Set([
  'data_unavailable',
])

export function classifyS12Structure(
  input: Pick<S12IntradayAssessment, 'state' | 'ready' | 'invalidated'> | {
    state?: unknown
    ready?: unknown
    invalidated?: unknown
  },
): S12StructureClass {
  const state = String(input.state ?? '').trim().toLowerCase()
  if (input.invalidated === true || input.invalidated === 1 || state === 'invalidated') return 'invalidated'
  if (!state || UNAVAILABLE_STATES.has(state)) return 'unavailable'
  if (RISK_BLOCKED_STATES.has(state)) return 'risk_blocked'
  if (EXECUTION_READY_STATES.has(state) && (input.ready === true || input.ready === 1)) return 'execution_ready'
  return 'setup_waiting'
}

export function s12StructureBlockedReason(
  input: Parameters<typeof classifyS12Structure>[0],
): string | null {
  const structureClass = classifyS12Structure(input)
  if (structureClass === 'execution_ready') return null
  const state = String(input.state ?? '').trim().toLowerCase()
  return state ? `s12_state_${state}` : 's12_structure_unavailable'
}
