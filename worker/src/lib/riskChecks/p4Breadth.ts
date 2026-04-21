/**
 * p4Breadth.ts — Layer 4: Market breadth gate (bull alignment % < threshold)
 * 2026-04-21 R1 extract from paper.ts L4.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

export async function checkP4Breadth(
  db: D1Database,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps

  const breadth = await db.prepare(
    'SELECT bull_alignment_pct, advance_ratio FROM market_breadth ORDER BY date DESC LIMIT 1'
  ).first<any>()

  const bullAlignmentThreshold = cc.bullAlignmentThreshold ?? 20
  if (breadth?.bull_alignment_pct == null) {
    console.warn('[CircuitBreaker] Layer4: market_breadth missing or NULL — skipping breadth check')
    return null
  }

  if (breadth.bull_alignment_pct < bullAlignmentThreshold) {
    const advRatio = breadth.advance_ratio != null ? ` adv_ratio=${Number(breadth.advance_ratio).toFixed(2)}` : ''
    console.warn(`[CircuitBreaker] Layer4: bull alignment ${breadth.bull_alignment_pct}% < ${bullAlignmentThreshold}%${advRatio}, reducing position`)
    return { ...defaults, maxPositionPct: cc.highVolReducedPosPct }
  }

  return null
}
