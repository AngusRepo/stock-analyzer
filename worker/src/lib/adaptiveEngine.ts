/**
 * adaptiveEngine.ts — 每日自適應參數計算引擎
 *
 * Phase 3 MVC：
 *   1. Worker pre-query D1（market_risk + model_accuracy + paper_orders）
 *   2. POST Controller /risk-assess → 計算 4 種自適應參數
 *   3. Worker 寫入 KV `ml:adaptive_params`
 *
 * 若 ML_CONTROLLER_URL 未設定 → 走 legacy 本地計算路徑
 *
 * T+1 生效：今天算的參數明天才用，斷開 feedback loop。
 */

import type { AdaptiveParams } from './adaptiveConfig'
import { getAdaptiveParams, setAdaptiveParams } from './adaptiveConfig'
import { summarizeSellOrderLosses } from './paperOrderAccounting'

// ── Phase A 改寫：所有 daily formula 從 trading:config.L2_formula 讀係數 ─────
// 不再 hardcode，公式 inputs 全來自 KV，讓未來 Optuna L2 search 可介入

import type { TradingConfig } from './tradingConfig'

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Phase A: 回傳 delta（不是 absolute）— delta = baseline 之外的相對調整 */
function computeConfidenceDelta(
  riskScore: number,
  accuracy30d: number,
  L2: TradingConfig['L2_formula'],
): number {
  const riskAdj = (riskScore / 100) * L2.confidence_risk_mult
  const perfAdj = (0.6 - accuracy30d) * L2.confidence_perf_mult
  return clip(riskAdj + perfAdj, L2.confidence_delta_clip_lo, L2.confidence_delta_clip_hi)
}

function computeSLTPAdd(
  riskLevel: string,
  L2: TradingConfig['L2_formula'],
): AdaptiveParams['sltp_add'] {
  switch (riskLevel) {
    case 'orange': return { sl_add: L2.sltp_add_orange_sl, tp_add: L2.sltp_add_orange_tp }
    case 'red':    return { sl_add: L2.sltp_add_red_sl,    tp_add: L2.sltp_add_red_tp }
    case 'black':  return { sl_add: L2.sltp_add_black_sl,  tp_add: L2.sltp_add_black_tp }
    default:       return null
  }
}

function computeBanditProtection(
  losses5d: number,
  total5d: number,
  L2: TradingConfig['L2_formula'],
) {
  if (total5d === 0) return { banditMaxMult: L2.bandit_max_mult_low, banditForceExplore: false }
  const lossRate = losses5d / total5d
  if (lossRate > L2.bandit_loss_thresh_high) return { banditMaxMult: L2.bandit_max_mult_high, banditForceExplore: true }
  if (lossRate > L2.bandit_loss_thresh_med)  return { banditMaxMult: L2.bandit_max_mult_med,  banditForceExplore: false }
  return { banditMaxMult: L2.bandit_max_mult_low, banditForceExplore: false }
}

function computePFQualityMults(
  rows30d: { model_name: string; profit_factor: number | null; total_count: number }[],
  rows90d: { model_name: string; profit_factor: number | null }[],
  L2: TradingConfig['L2_formula'],
): Record<string, number> {
  const pf90Map: Record<string, number> = {}
  for (const r of rows90d) { if (r.profit_factor != null) pf90Map[r.model_name] = r.profit_factor }
  const result: Record<string, number> = {}
  const lo = L2.pf_quality_clip_lo
  const hi = L2.pf_quality_clip_hi
  const w30 = L2.pf_quality_30d_weight
  const w90 = L2.pf_quality_90d_weight
  // min_sample_size=10 here: per-model aggregated across all stocks, easy to pass.
  // Anti-noise guard, not an Optuna target — PF 小樣本 noisy，避免亂調 pf_quality_mult。
  for (const r of rows30d) {
    if (r.total_count < 10 || r.profit_factor == null) { result[r.model_name] = 1.0; continue }
    const pf30 = clip(r.profit_factor, lo, hi)
    const pf90 = pf90Map[r.model_name] != null ? clip(pf90Map[r.model_name]!, lo, hi) : pf30
    result[r.model_name] = clip(pf30 * w30 + pf90 * w90, lo, hi)
  }
  return result
}

// ── Pre-query D1 data ─────────────────────────────────────────────────────────

async function queryAdaptiveInputs(env: { DB: D1Database; KV: KVNamespace }) {
  const riskRow = await env.DB.prepare(
    'SELECT risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<{ risk_score: number; risk_level: string }>()

  // 2026-04-09 fix: 全市場 30d 準確率改用加權平均 SUM(correct)/SUM(total)
  // 原本 AVG(accuracy) + total_count>=10 會被單檔 outlier 主導（當時只有 1 檔過門檻且 acc=0）
  // min_sample_size=3 是純 anti-noise 守門員，不是交易參數所以 hardcode 不進 KV
  const accGlobal = await env.DB.prepare(`
    SELECT CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS avg_acc
    FROM model_accuracy WHERE period='30d' AND total_count >= 3
  `).first<{ avg_acc: number | null }>()

  // 2026-04-09 fix: updated_at → last_updated (實際欄位名)；
  // 舊 HAVING MAX(updated_at) 是無效語法，會 runtime 錯被 catch 吞成空陣列，
  // rows30d/90d 變空 → computePFQualityMults 全 fallback 1.0。
  // 改成 model_name 維度加權 profit_factor（跨 stock），符合原本消費端語意。
  const { results: rows30d } = await env.DB.prepare(`
    SELECT model_name,
           SUM(total_count) AS total_count,
           CASE WHEN SUM(total_count) > 0 AND SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END) > 0
                THEN SUM(COALESCE(profit_factor, 0) * total_count) / SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END)
                ELSE NULL END AS profit_factor
    FROM model_accuracy WHERE period='30d'
    GROUP BY model_name
  `).all<any>().catch(() => ({ results: [] as any[] }))

  const { results: rows90d } = await env.DB.prepare(`
    SELECT model_name,
           CASE WHEN SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END) > 0
                THEN SUM(COALESCE(profit_factor, 0) * total_count) / SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END)
                ELSE NULL END AS profit_factor
    FROM model_accuracy WHERE period='90d'
    GROUP BY model_name
  `).all<any>().catch(() => ({ results: [] as any[] }))

  const fiveDaysAgo = new Date(Date.now() + 8 * 3600_000 - 5 * 86400_000).toISOString().slice(0, 10)
  const { results: recentSellRows } = await env.DB.prepare(`
    SELECT price, shares, commission, tax, note
    FROM paper_orders WHERE side='sell' AND created_at >= ?
  `).bind(fiveDaysAgo).all<any>().catch(() => ({ results: [] as any[] }))
  const recentOrders = summarizeSellOrderLosses(recentSellRows ?? [])

  // RRG Quadrant 分布（多數 Lagging → 提高門檻）
  const { results: qDistRows } = await env.DB.prepare(`
    SELECT quadrant, COUNT(*) as cnt FROM sector_flow
    WHERE classification = 'theme' AND quadrant IS NOT NULL
      AND date = (SELECT MAX(date) FROM sector_flow WHERE classification = 'theme' AND quadrant IS NOT NULL)
    GROUP BY quadrant
  `).all<any>().catch(() => ({ results: [] as any[] }))
  const qDist: Record<string, number> = {}
  let qTotal = 0
  for (const r of qDistRows ?? []) { qDist[r.quadrant] = r.cnt; qTotal += r.cnt }

  return {
    riskScore:   riskRow?.risk_score ?? 50,
    riskLevel:   riskRow?.risk_level ?? 'medium',
    accuracy30d: accGlobal?.avg_acc ?? 0.6,
    rows30d:     rows30d ?? [],
    rows90d:     rows90d ?? [],
    losses5d:    recentOrders.losses,
    total5d:     recentOrders.total,
    quadrantDist: qDist,
    quadrantTotal: qTotal,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runAdaptiveUpdate(env: {
  DB: D1Database
  KV: KVNamespace
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
}): Promise<string> {
  const inputs = await queryAdaptiveInputs(env)
  const current = await getAdaptiveParams(env.KV)
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  let params: AdaptiveParams

  if (env.ML_CONTROLLER_URL) {
    // ── Phase 3: Controller 路徑 ──────────────────────────────────────────
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
      const res = await fetch(`${env.ML_CONTROLLER_URL}/risk-assess`, {
        method: 'POST', headers,
        body: JSON.stringify({
          date: today,
          market: { risk_score: inputs.riskScore, risk_level: inputs.riskLevel },
          accuracy: { global_30d: inputs.accuracy30d, rows_30d: inputs.rows30d, rows_90d: inputs.rows90d },
          trading: { losses_5d: inputs.losses5d, total_5d: inputs.total5d },
          current_version: current.version ?? 0,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Controller /risk-assess HTTP ${res.status}`)
      const data = await res.json() as any
      params = data.adaptive_params
      const summary = data.summary ?? 'Controller OK'
      await setAdaptiveParams(env.KV, params)
      console.log(`[AdaptiveEngine] Controller: ${summary}`)
      return summary
    } catch (e) {
      console.warn('[AdaptiveEngine] Controller failed, using legacy fallback:', e)
    }
  }

  // ── Legacy fallback: 本地計算（Phase A 改寫為 delta-only + 讀 L2 KV） ────
  const { getTradingConfig } = await import('./tradingConfig')
  const tradingCfg = await getTradingConfig(env.KV)
  const L2 = tradingCfg.L2_formula

  let confidenceDelta = computeConfidenceDelta(inputs.riskScore, inputs.accuracy30d, L2)
  // RRG 加成：多數概念在 Lagging → 加嚴 delta（市場整體弱勢）
  if (inputs.quadrantTotal > 0) {
    const laggingPct = (inputs.quadrantDist['Lagging'] ?? 0) / inputs.quadrantTotal
    if (laggingPct > 0.5) {
      const boost = clip((laggingPct - 0.5) * 0.1, 0, 0.05) // 最多 +0.05
      confidenceDelta = clip(confidenceDelta + boost, L2.confidence_delta_clip_lo, L2.confidence_delta_clip_hi)
      console.log(`[AdaptiveEngine] RRG boost: ${(laggingPct * 100).toFixed(0)}% Lagging → delta +${(boost * 100).toFixed(1)}%`)
    }
  }
  const pfQualityMult       = computePFQualityMults(inputs.rows30d, inputs.rows90d, L2)
  const sltpAdd             = computeSLTPAdd(inputs.riskLevel, L2)
  const { banditMaxMult, banditForceExplore } = computeBanditProtection(inputs.losses5d, inputs.total5d, L2)
  const newVersion = (current.version ?? 0) + 1

  // Phase A: 純 delta schema，legacy 欄位保留 backwards compat
  // Legacy confidence_threshold 用 baseline + delta 重算給 backwards compat
  const baselineConfidence = tradingCfg.signal.buySignalScore  // Optuna #2 baseline
  const legacyConfidenceThreshold = clip(
    baselineConfidence + confidenceDelta,
    L2.confidence_effective_clip_lo,
    L2.confidence_effective_clip_hi,
  )

  params = {
    // 新 schema (delta-based)
    confidence_delta:      confidenceDelta,
    position_pct_delta:    0,  // Phase 補齊：將來算 risk-adjusted position delta
    sltp_add:              sltpAdd,
    pf_quality_mult:       pfQualityMult,
    bandit_max_mult:       banditMaxMult,
    bandit_force_explore:  banditForceExplore,
    computed_at:           new Date(Date.now() + 8 * 3600_000).toISOString(),
    market_risk_score:     inputs.riskScore,
    recent_accuracy_30d:   Math.round(inputs.accuracy30d * 100) / 100,
    version:               newVersion,

    // legacy fields (backwards compat for current paper.ts wiring，Phase 2 移除)
    confidence_threshold:  legacyConfidenceThreshold,
    sl_tp_override:        sltpAdd,
  }

  await setAdaptiveParams(env.KV, params)

  const summary = [
    `v${newVersion}`,
    `conf_delta=${confidenceDelta >= 0 ? '+' : ''}${confidenceDelta.toFixed(3)}`,
    `eff=${legacyConfidenceThreshold.toFixed(2)}`,
    `risk=${inputs.riskLevel}(${inputs.riskScore})`,
    `acc30d=${(inputs.accuracy30d * 100).toFixed(0)}%`,
    `bandit=${banditForceExplore ? 'explore!' : `maxMult=${banditMaxMult}`}`,
    sltpAdd ? `sl+${sltpAdd.sl_add}/tp+${sltpAdd.tp_add}` : 'sl/tp=default',
  ].join(' | ')

  console.log(`[AdaptiveEngine] Legacy: ${summary}`)
  return summary
}
