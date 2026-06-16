import type { CircuitBreakerState, LegacyLayerDeps } from '../riskTypes'

export function failClosedRiskCheck(
  layerId: string,
  error: unknown,
  deps: LegacyLayerDeps,
): CircuitBreakerState {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...deps.defaults,
    halt: true,
    maxPositionPct: 0,
    buyConfThreshold: 1,
    sellConfThreshold: 1,
    reason: `${layerId} risk check unavailable: ${message}`,
  }
}
