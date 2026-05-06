import { summarizeSellOrderLosses } from '../paperOrderAccounting'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

const ACCOUNT_ID = 1

export async function checkP5Losses(
  db: D1Database,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const { defaults } = deps

  try {
    const { results: recentSells } = await db.prepare(
      `SELECT price, shares, commission, tax, note
         FROM paper_orders
        WHERE account_id=? AND side='sell'
        ORDER BY id DESC
        LIMIT 5`,
    ).bind(ACCOUNT_ID).all<any>()

    if (!recentSells || recentSells.length < 3) return null

    const summary = summarizeSellOrderLosses(recentSells)
    if (summary.total < 3 || summary.losses < 3) return null

    console.warn(`[CircuitBreaker] Layer5 HALT: ${summary.losses}/${summary.total} recent closed trades are losses`)
    return {
      halt: true,
      reason: `近 ${summary.total} 筆已平倉交易中有 ${summary.losses} 筆虧損，啟動 SafetyMode`,
      ...defaults,
    }
  } catch (e) {
    console.warn('[CircuitBreaker] Layer5 check failed (non-fatal):', e)
    return null
  }
}
