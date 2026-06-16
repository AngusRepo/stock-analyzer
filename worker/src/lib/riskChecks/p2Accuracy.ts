/**
 * p2Accuracy.ts - Layer 2: model accuracy evidence.
 *
 * Runtime sources:
 * 1. ml:adaptive_params.recent_accuracy_30d from ml-controller.
 * 2. model_accuracy active-9 aggregate as the local authoritative table.
 *
 * No predictions-table fallback: if both sources are unavailable, fail closed.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

const ACTIVE_9_MODELS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
  'TimesFM',
]

async function readActive9ModelAccuracy30d(db: D1Database): Promise<{ accuracy: number; samples: number } | null> {
  const placeholders = ACTIVE_9_MODELS.map(() => '?').join(', ')
  const row = await db.prepare(`
    SELECT CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS accuracy,
           SUM(total_count) AS samples
      FROM model_accuracy
     WHERE period='30d'
       AND total_count >= 3
       AND model_name IN (${placeholders})
  `).bind(...ACTIVE_9_MODELS).first<{ accuracy: number | null; samples: number | null }>()
  const accuracy = Number(row?.accuracy)
  const samples = Number(row?.samples)
  if (!Number.isFinite(accuracy) || !Number.isFinite(samples) || samples <= 0) return null
  return { accuracy, samples }
}

export async function checkP2Accuracy(
  db: D1Database,
  kv: KVNamespace | undefined,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults, effectiveBuy } = deps
  let recentAcc: number | null = null
  let evidenceSource = 'missing'
  const evidenceErrors: string[] = []

  if (kv) {
    try {
      const { getAdaptiveParams } = await import('../adaptiveConfig')
      const adaptive = await getAdaptiveParams(kv)
      if (adaptive?.recent_accuracy_30d != null) {
        recentAcc = adaptive.recent_accuracy_30d
        evidenceSource = 'ml:adaptive_params'
      }
    } catch (error: any) {
      evidenceErrors.push(`adaptive_params:${error?.message ?? error}`)
    }
  }

  if (recentAcc == null) {
    try {
      const observed = await readActive9ModelAccuracy30d(db)
      if (observed) {
        recentAcc = observed.accuracy
        evidenceSource = `model_accuracy.active9.samples_${observed.samples}`
      }
    } catch (error: any) {
      evidenceErrors.push(`model_accuracy:${error?.message ?? error}`)
    }
  }

  if (recentAcc == null) {
    console.warn(`[CircuitBreaker] Layer2: model accuracy evidence unavailable; fail closed (${evidenceErrors.join('; ') || 'no evidence'})`)
    return {
      halt: true,
      reason: `P2 model accuracy evidence unavailable (${evidenceErrors.join('; ') || 'no evidence'})`,
      maxPositionPct: 0,
      buyConfThreshold: 1.0,
      sellConfThreshold: Math.max(defaults.sellConfThreshold, 1.0),
    }
  }

  if (recentAcc < cc.lowAccuracyThreshold) {
    console.warn(`[CircuitBreaker] Layer2: model accuracy ${(recentAcc * 100).toFixed(1)}% < ${(cc.lowAccuracyThreshold * 100).toFixed(0)}%, raising threshold source=${evidenceSource}`)
    const raisedConf = Math.max(effectiveBuy, cc.drawdownRaisedConf)
    return {
      ...defaults,
      buyConfThreshold: raisedConf,
      sellConfThreshold: raisedConf,
      reason: `P2 model accuracy ${(recentAcc * 100).toFixed(1)}% source=${evidenceSource}`,
    }
  }

  return null
}
