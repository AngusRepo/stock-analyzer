/**
 * adaptiveConfig.ts — Adaptive Parameter System KV 讀寫
 *
 * KV key: `ml:adaptive_params`
 * 每日 16:05 verify 完後由 adaptiveEngine 計算寫入，次日生效。
 */

export interface AdaptiveParams {
  // ── 信心門檻（market risk 感知）────────────────────────────────────────────
  confidence_threshold: number           // 0.55~0.75

  // ── Ensemble PF 品質權重（per-model，基於 30d profit_factor）────────────────
  pf_quality_mult: Record<string, number>

  // ── SL/TP Regime 覆蓋（高風險時加寬）─────────────────────────────────────
  sl_tp_override: {
    sl_add: number   // 額外加寬的 ATR 倍數
    tp_add: number
  } | null

  // ── LinUCB 保護（連續虧損時防 feedback loop）──────────────────────────────
  bandit_max_mult: number                // 1.5~2.5
  bandit_force_explore: boolean          // 連續虧損時強制探索

  // ── Meta（審計用）─────────────────────────────────────────────────────────
  computed_at: string                    // ISO timestamp（TW time）
  market_risk_score: number              // 計算時的 risk score
  recent_accuracy_30d: number            // 計算時的整體 30d 準確率
  version: number                        // 遞增版本號
}

export const DEFAULT_ADAPTIVE_PARAMS: AdaptiveParams = {
  confidence_threshold: 0.60,
  pf_quality_mult: {},
  sl_tp_override: null,
  bandit_max_mult: 2.5,
  bandit_force_explore: false,
  computed_at: '',
  market_risk_score: 50,
  recent_accuracy_30d: 0.6,
  version: 0,
}

const KV_KEY = 'ml:adaptive_params'
const CACHE_TTL_MS = 300_000  // 5 min

let _cached: AdaptiveParams | null = null
let _cachedAt = 0

export async function getAdaptiveParams(kv: KVNamespace): Promise<AdaptiveParams> {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached
  try {
    const raw = await kv.get(KV_KEY, 'json') as AdaptiveParams | null
    _cached = raw ?? DEFAULT_ADAPTIVE_PARAMS
  } catch {
    _cached = DEFAULT_ADAPTIVE_PARAMS
  }
  _cachedAt = Date.now()
  return _cached
}

export async function setAdaptiveParams(kv: KVNamespace, params: AdaptiveParams): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify(params))
  _cached = params
  _cachedAt = Date.now()
}

export function invalidateAdaptiveCache(): void {
  _cached = null
  _cachedAt = 0
}
