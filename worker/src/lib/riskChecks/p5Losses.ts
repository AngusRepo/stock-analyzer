import { paperAccountId } from '../paperExecutionScope'
import { summarizeSellOrderLosses } from '../paperOrderAccounting'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import { failClosedRiskCheck } from './failClosed'

// Loss count reduces Paper sizing; monetary loss/drawdown gates own hard halts.
export const P5_LOSS_POSITION_SCALE = 0.5
export const P5_LOSS_POLICY = 'paper-loss-count-scale-v1'

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
          AND id > COALESCE((SELECT MAX(cutoff_sell_id) FROM paper_p5_rearms_v1 WHERE account_id=?),0)
        ORDER BY id DESC
        LIMIT 5`,
    ).bind(paperAccountId(), paperAccountId()).all<any>()

    if (!recentSells || recentSells.length < 3) return null

    const summary = summarizeSellOrderLosses(recentSells)
    if (summary.total < 3 || summary.losses < 3) return null

    console.warn(`[CircuitBreaker] Layer5 SCALE: ${summary.losses}/${summary.total} recent closed trades are losses; position cap × ${P5_LOSS_POSITION_SCALE}`)
    return {
      ...defaults,
      reason: `近 ${summary.total} 筆已平倉交易中有 ${summary.losses} 筆虧損，部位上限降為原設定的 50%（虧損筆數不停止買入）`,
      maxPositionPct: defaults.maxPositionPct * P5_LOSS_POSITION_SCALE,
    }
  } catch (e) {
    console.error('[CircuitBreaker] Layer5 check failed; fail closed:', e)
    return failClosedRiskCheck('P5', e, deps)
  }
}
