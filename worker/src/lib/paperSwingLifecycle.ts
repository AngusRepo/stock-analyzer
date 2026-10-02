import { SWING_POLICY_VERSION, type SwingPositionState } from './paperSwingPolicy'
export function readSwingState(raw: unknown): SwingPositionState | null {
  let value: any
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  const state = (value as any)?.swing
  if (!state || state.policy !== SWING_POLICY_VERSION) return null
  if (![state.entryPrice,state.entryOrLow].every(x=>Number.isFinite(x)&&x>0)
    || !/^\d{4}-\d{2}-\d{2}$/.test(state.entryDate)) throw new Error('swing_lifecycle_invalid')
  return state
}
export function writeSwingState(raw: unknown, state: SwingPositionState): string {
  const value = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
  return JSON.stringify({...value,swing:state,owners:{...(value as any)?.owners,
    entry:SWING_POLICY_VERSION,exit:SWING_POLICY_VERSION,fallbackExit:SWING_POLICY_VERSION},
    exit:{...(value as any)?.exit,initialStop:state.entryPrice*.92,trailingStop:state.entryPrice*.92,
      tp1:null,tp2:null,tp1Source:null,tp2Source:null,fusionPolicy:null,protectiveFloorPolicy:null,fallbackOwner:SWING_POLICY_VERSION},position_tp1_progress:undefined})
}
