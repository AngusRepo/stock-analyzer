// Relative circuit position scales (trading:config.circuit.positionScales).
// Each scale multiplies the circuit baseline maxPositionPct, so a change to the
// baseline never moves the L4 single-name ratio. The block is never defaulted:
// the merged config (and its runtime approval identity) changes only when the
// staged policy activation writes it. Until then each layer keeps its legacy
// constant, and the legacy branch is removed with the next source grant.
export interface CircuitPositionScales {
  highVol: number
  severeHighVol: number
  momentumZone: { RED: number; YELLOW: number }
  lossStreak: number
}

export function circuitPositionScales(circuit: { positionScales?: unknown } | null | undefined): CircuitPositionScales | null {
  const scales = circuit?.positionScales as CircuitPositionScales | undefined | null
  if (scales === undefined || scales === null) return null
  const zone = (scales as any).momentumZone
  const values = [scales.highVol, scales.severeHighVol, zone?.RED, zone?.YELLOW, scales.lossStreak]
  if (typeof scales !== 'object' || Object.keys(scales).sort().join() !== 'highVol,lossStreak,momentumZone,severeHighVol'
      || typeof zone !== 'object' || zone === null || Object.keys(zone).sort().join() !== 'RED,YELLOW'
      || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1)) {
    throw new Error('circuit_position_scales_invalid')
  }
  return scales
}
