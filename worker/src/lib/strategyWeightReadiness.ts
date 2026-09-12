/** Existing readiness-only adaptive base; shared by daily and frozen replay.
 * These are the existing values, not a new performance/promotion gate.
 */
export const STRATEGY_WEIGHT_MIN_SAMPLES = 30
export const STRATEGY_WEIGHT_MIN_MATURE_DATES = 10

export function strategyWeightEvidenceReady(samples: number, matureDates: number): boolean {
  return samples >= STRATEGY_WEIGHT_MIN_SAMPLES && matureDates >= STRATEGY_WEIGHT_MIN_MATURE_DATES
}

export interface StrategyReadinessObservation {
  id: string; version: string; status: string; samples: number; matureDates: number
}

export function buildStrategyReadinessWeights(observations: readonly StrategyReadinessObservation[],
  gates: readonly { strategy_id: string; strategy_version: string; allocation_eligible: boolean }[]): Record<string, number> {
  const byId = new Map(gates.map(gate => [`${gate.strategy_id}|${gate.strategy_version}`, gate]))
  const active = observations.filter(spec => spec.status === 'active')
    .map(spec => ({ id: spec.id, ready: byId.get(`${spec.id}|${spec.version}`)?.allocation_eligible === true
      && strategyWeightEvidenceReady(spec.samples, spec.matureDates) }))
  const total = active.filter(spec => spec.ready).length
  const weight = total > 0 ? Math.round((1 / total) * 1_000_000) / 1_000_000 : 0
  const ready = new Set(active.filter(spec => spec.ready).map(spec => spec.id))
  return Object.fromEntries(observations.filter(spec => spec.status !== 'retired')
    .map(spec => [spec.id, ready.has(spec.id) ? weight : 0]))
}
