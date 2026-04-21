/**
 * p2Accuracy.ts — Layer 2: Model accuracy gate (30d recent)
 *
 * Reads adaptive_params.recent_accuracy_30d first (single source of truth),
 * falls back to local SQL over predictions table if unavailable.
 * 2026-04-21 R1 extract from paper.ts L2.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

export async function checkP2Accuracy(
  db: D1Database,
  kv: KVNamespace | undefined,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults, effectiveBuy } = deps

  const defaultAcc = cc.defaultAccuracy ?? 0.5
  let recentAcc = defaultAcc

  if (kv) {
    try {
      const { getAdaptiveParams } = await import('../adaptiveConfig')
      const adaptive = await getAdaptiveParams(kv)
      if (adaptive?.recent_accuracy_30d != null) {
        recentAcc = adaptive.recent_accuracy_30d
      }
    } catch {
      /* fallback to local SQL */
    }
  }

  if (recentAcc === defaultAcc) {
    // Sprint 4-3 root cause fix (2026-04-07):
    // WHERE direction_correct IN (0, 1) excludes -1 (neutral HOLD/NO_SIGNAL)
    const accuracyRow = await db.prepare(`
      SELECT AVG(CASE WHEN direction_correct=1 THEN 1.0 ELSE 0.0 END) as acc
      FROM predictions
      WHERE generated_at >= datetime('now', '-30 days')
      AND direction_correct IN (0, 1)
    `).first<any>()
    recentAcc = accuracyRow?.acc ?? defaultAcc
  }

  if (recentAcc < cc.lowAccuracyThreshold) {
    console.warn(`[CircuitBreaker] Layer2: model accuracy ${(recentAcc * 100).toFixed(1)}% < ${(cc.lowAccuracyThreshold * 100).toFixed(0)}%, raising threshold`)
    const raisedConf = Math.max(effectiveBuy, cc.drawdownRaisedConf)
    return {
      ...defaults,
      buyConfThreshold: raisedConf,
      sellConfThreshold: raisedConf,
      reason: `模型近期準確率 ${(recentAcc * 100).toFixed(1)}%`,
    }
  }

  return null
}
