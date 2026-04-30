/**
 * adaptiveConfig.ts — Adaptive Parameter System KV 讀寫
 *
 * KV key: `ml:adaptive_params`
 * 每日 16:05 verify 完後由 adaptiveEngine 計算寫入，次日生效。
 */

export interface AdaptiveParams {
  // ─────────────────────────────────────────────────────────────────────────
  // ⚠️ DEPRECATED FIELDS (backwards compat only, will be removed in Phase 3.5)
  // 之前的設計：absolute value，但這跟 trading:config baseline 邏輯衝突
  // ─────────────────────────────────────────────────────────────────────────
  /** @deprecated 用 confidence_delta 取代；absolute value 會跟 baseline double-count */
  confidence_threshold?: number           // legacy 0.55~0.75

  /** @deprecated 改寫進 trading:config.sltp.slMultBase，這只應該裝 sl_add delta */
  sl_mult_base?: number                  // legacy

  /** @deprecated 改寫進 trading:config.sltp.tpMultBase */
  tp_mult_base?: number                  // legacy

  /** @deprecated 改寫進 trading:config.signal.* */
  strong_signal_score?: number
  /** @deprecated 改寫進 trading:config.signal.buySignalScore */
  buy_signal_score?: number
  /** @deprecated 改寫進 trading:config.signal.holdSignalScore */
  hold_signal_score?: number

  // ─────────────────────────────────────────────────────────────────────────
  // 新 schema（純 T+1 daily delta，2026-04-07 引入）
  // 設計原則：所有欄位都是「相對於 trading:config baseline 的 delta」
  // paper.ts 讀法：effective = clip(baseline + delta, KV-driven range)
  // ─────────────────────────────────────────────────────────────────────────

  /** 信心門檻 daily delta（-0.10 ~ +0.20）對 trading:config.signal.buySignalScore */
  confidence_delta: number

  /** Position size daily delta（-0.04 ~ +0.04）對 trading:config.position.maxPctOfPortfolio */
  position_pct_delta: number

  /** SL/TP 加碼 (從 risk_level 算)，套在 trading:config.sltp.slMultBase/tpMultBase 上 */
  sltp_add: {
    sl_add: number   // 額外加寬的 ATR 倍數（相對 baseline）
    tp_add: number
  } | null

  // ── Ensemble PF 品質權重（per-model）─ 這個本來就是 multiplier 不是 absolute，留 ──
  pf_quality_mult: Record<string, number>

  screener?: {
    candidate_pool_delta?: number
    ml_shortlist_delta?: number
    emerging_research_delta?: number
  }

  // ── LinUCB 保護 ─ 這個是 absolute mult，留在 adaptive_params 因為跟 daily 表現相關 ──
  bandit_max_mult: number                // 1.5~2.5
  bandit_force_explore: boolean

  // ── Meta（審計用）─────────────────────────────────────────────────────────
  computed_at: string                    // ISO timestamp（TW time）
  market_risk_score: number              // 計算時的 risk score
  recent_accuracy_30d: number            // 計算時的整體 30d 準確率（CB Layer2 也讀此值，避免重算）
  regime_at_compute?: number             // 0-3，計算時的 market regime（Phase B 加）
  version: number                        // 遞增版本號

  // ─────────────────────────────────────────────────────────────────────────
  // DEPRECATED legacy field for backwards compat（Phase 3.5 移除）
  // ─────────────────────────────────────────────────────────────────────────
  /** @deprecated 改用 sltp_add */
  sl_tp_override?: { sl_add: number; tp_add: number } | null
}

export const DEFAULT_ADAPTIVE_PARAMS: AdaptiveParams = {
  // 新 delta schema
  confidence_delta: 0,
  position_pct_delta: 0,
  sltp_add: null,
  pf_quality_mult: {},
  screener: {},
  bandit_max_mult: 2.5,
  bandit_force_explore: false,
  computed_at: '',
  market_risk_score: 50,
  recent_accuracy_30d: 0.6,
  version: 0,
  // legacy fields kept undefined（讀 KV 時若有值才會出現）
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
