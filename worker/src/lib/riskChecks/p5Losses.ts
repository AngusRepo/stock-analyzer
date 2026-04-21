/**
 * p5Losses.ts — Layer 5: Consecutive losses gate (nofx SafetyMode)
 * Last 5 closed trades, ≥3 losses → halt.
 * 2026-04-21 R1 extract from paper.ts L5 (last in legacy order due to ordering
 * decision — P6/P7 run before P5 so Layer 5 HALT can't mask them).
 */
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

const ACCOUNT_ID = 1

export async function checkP5Losses(
  db: D1Database,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const { defaults } = deps

  try {
    const { results: recentSells } = await db.prepare(
      "SELECT price, note FROM paper_orders WHERE account_id=? AND side='sell' ORDER BY id DESC LIMIT 5"
    ).bind(ACCOUNT_ID).all<any>()

    if (!recentSells || recentSells.length < 3) return null

    let lossCount = 0
    for (const s of recentSells) {
      try {
        const n = typeof s.note === 'string' ? JSON.parse(s.note) : s.note
        const entry = n?.entry_price ?? s.price
        if (entry > 0 && s.price < entry) lossCount++
      } catch {
        // Malformed note JSON — conservatively count as loss (defensive)
        if (s.price > 0) lossCount++
      }
    }

    if (lossCount < 3) return null

    console.warn(`[CircuitBreaker] Layer5 HALT: ${lossCount}/${recentSells.length} 近期交易虧損，暫停掛單`)
    return { halt: true, reason: `連續 ${lossCount} 筆虧損（SafetyMode）`, ...defaults }
  } catch (e) {
    console.warn('[CircuitBreaker] Layer5 check failed (non-fatal):', e)
    return null
  }
}
