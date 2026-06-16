/**
 * p7Streak.ts — Layer 7: Recent prediction streak (nofx-inspired 急性降載)
 * Checks last 5 verified predictions; ≥4 wrong → posPct × 0.3.
 * Complements Layer 2: L2=slow signal (30d), L7=acute signal (5 latest).
 * 2026-04-21 R1 extract from paper.ts L7.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import { failClosedRiskCheck } from './failClosed'

export async function checkP7Streak(
  db: D1Database,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps

  try {
    const { results: recent } = await db.prepare(`
      SELECT direction_correct FROM predictions
       WHERE direction_correct IN (0, 1)
       ORDER BY generated_at DESC LIMIT 5
    `).all<{ direction_correct: number }>()

    if (!recent || recent.length < 5) return null

    const wrongCount = recent.filter((r: any) => Number(r.direction_correct) === 0).length
    if (wrongCount < 4) return null

    const layer7Scale = cc.layer7ScaleRatio ?? 0.3
    const adjusted = defaults.maxPositionPct * layer7Scale
    console.warn(
      `[CircuitBreaker] Layer7 SCALE: recent streak ${wrongCount}/5 wrong ` +
      `→ posPct ${(adjusted * 100).toFixed(1)}% (× ${layer7Scale})`
    )
    return {
      ...defaults,
      maxPositionPct: adjusted,
      reason: `近 5 筆預測 ${wrongCount} 次錯誤（急性降載）`,
    }
  } catch (e) {
    console.error('[CircuitBreaker] Layer7 check failed; fail closed:', e)
    return failClosedRiskCheck('P7', e, deps)
  }
}
