/**
 * p6Momentum.ts — Layer 6: Momentum Crash Zone gate (Daniel & Moskowitz 2016)
 * Checks 36-month percentile rank of candidate-pool crowding.
 * RED (rank>P90) × 0.3 / YELLOW (P70-P90) × 0.7 / GREEN pass-through.
 * 2026-04-21 R1 extract from paper.ts L6.
 */
import type { LegacyLayerDeps, LegacyLayerResult, MomentumZone } from '../riskTypes'
import { failClosedRiskCheck } from './failClosed'

export async function checkP6Momentum(
  db: D1Database,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const { defaults } = deps

  try {
    const { readCurrentZone, ZONE_MULTIPLIER } = await import('../momentumZone')
    const zoneInfo = await readCurrentZone(db)
    if (zoneInfo.zone === 'GREEN') return null

    const zone = zoneInfo.zone as MomentumZone
    const mult = ZONE_MULTIPLIER[zone]
    const adjusted = defaults.maxPositionPct * mult
    console.warn(
      `[CircuitBreaker] Layer6: momentum zone ${zone} ` +
      `(date=${zoneInfo.date}, rank=${zoneInfo.percentile_rank?.toFixed(3) ?? 'n/a'}) ` +
      `→ posPct ${(adjusted * 100).toFixed(1)}% (× ${mult})`
    )
    return {
      ...defaults,
      maxPositionPct: adjusted,
      momentumZone: zone,
      reason: `動能擁擠 ${zone}（rank ${((zoneInfo.percentile_rank ?? 0) * 100).toFixed(0)}%）`,
    }
  } catch (e) {
    console.error('[CircuitBreaker] Layer6 check failed; fail closed:', e)
    return failClosedRiskCheck('P6', e, deps)
  }
}
