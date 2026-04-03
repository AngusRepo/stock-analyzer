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

// ── Legacy 計算函數（Controller 未部署時的 fallback）──────────────────────────

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function computeConfidenceThreshold(riskScore: number, accuracy30d: number): number {
  return clip(0.60 + (riskScore / 100) * 0.15 + (0.6 - accuracy30d) * 0.20, 0.55, 0.75)
}

function computeSLTPOverride(riskLevel: string): AdaptiveParams['sl_tp_override'] {
  switch (riskLevel) {
    case 'orange': return { sl_add: 0.3, tp_add: 0.3 }
    case 'red':    return { sl_add: 0.5, tp_add: 0.5 }
    case 'black':  return { sl_add: 1.0, tp_add: 0.5 }
    default:       return null
  }
}

function computeBanditProtection(losses5d: number, total5d: number) {
  if (total5d === 0) return { banditMaxMult: 2.5, banditForceExplore: false }
  const lossRate = losses5d / total5d
  if (lossRate > 0.6) return { banditMaxMult: 1.5, banditForceExplore: true }
  if (lossRate > 0.4) return { banditMaxMult: 2.0, banditForceExplore: false }
  return { banditMaxMult: 2.5, banditForceExplore: false }
}

function computePFQualityMults(
  rows30d: { model_name: string; profit_factor: number | null; total_count: number }[],
  rows90d: { model_name: string; profit_factor: number | null }[],
): Record<string, number> {
  const pf90Map: Record<string, number> = {}
  for (const r of rows90d) { if (r.profit_factor != null) pf90Map[r.model_name] = r.profit_factor }
  const result: Record<string, number> = {}
  for (const r of rows30d) {
    if (r.total_count < 10 || r.profit_factor == null) { result[r.model_name] = 1.0; continue }
    const pf30 = clip(r.profit_factor, 0.3, 1.8)
    const pf90 = pf90Map[r.model_name] != null ? clip(pf90Map[r.model_name]!, 0.3, 1.8) : pf30
    result[r.model_name] = clip(pf30 * 0.7 + pf90 * 0.3, 0.3, 1.8)
  }
  return result
}

// ── Pre-query D1 data ─────────────────────────────────────────────────────────

async function queryAdaptiveInputs(env: { DB: D1Database; KV: KVNamespace }) {
  const riskRow = await env.DB.prepare(
    'SELECT risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<{ risk_score: number; risk_level: string }>()

  const accGlobal = await env.DB.prepare(`
    SELECT AVG(accuracy) as avg_acc FROM model_accuracy WHERE period='30d' AND total_count >= 10
  `).first<{ avg_acc: number | null }>()

  const { results: rows30d } = await env.DB.prepare(`
    SELECT model_name, profit_factor, total_count FROM model_accuracy
    WHERE period='30d' GROUP BY model_name HAVING MAX(updated_at)
  `).all<any>().catch(() => ({ results: [] as any[] }))

  const { results: rows90d } = await env.DB.prepare(`
    SELECT model_name, profit_factor FROM model_accuracy
    WHERE period='90d' GROUP BY model_name HAVING MAX(updated_at)
  `).all<any>().catch(() => ({ results: [] as any[] }))

  const fiveDaysAgo = new Date(Date.now() + 8 * 3600_000 - 5 * 86400_000).toISOString().slice(0, 10)
  const recentOrders = await env.DB.prepare(`
    SELECT SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses, COUNT(*) as total
    FROM paper_orders WHERE side='sell' AND created_at >= ? AND realized_pnl IS NOT NULL
  `).bind(fiveDaysAgo).first<{ losses: number | null; total: number | null }>().catch(() => null)

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
    losses5d:    recentOrders?.losses ?? 0,
    total5d:     recentOrders?.total ?? 0,
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

  // ── Legacy fallback: 本地計算 ─────────────────────────────────────────────
  let confidenceThreshold = computeConfidenceThreshold(inputs.riskScore, inputs.accuracy30d)
  // RRG 加成：多數概念在 Lagging → 提高門檻（市場整體弱勢）
  if (inputs.quadrantTotal > 0) {
    const laggingPct = (inputs.quadrantDist['Lagging'] ?? 0) / inputs.quadrantTotal
    if (laggingPct > 0.5) {
      const boost = clip((laggingPct - 0.5) * 0.1, 0, 0.05) // 最多 +0.05
      confidenceThreshold = clip(confidenceThreshold + boost, 0.55, 0.75)
      console.log(`[AdaptiveEngine] RRG boost: ${(laggingPct * 100).toFixed(0)}% Lagging → conf +${(boost * 100).toFixed(1)}%`)
    }
  }
  const pfQualityMult       = computePFQualityMults(inputs.rows30d, inputs.rows90d)
  const slTpOverride        = computeSLTPOverride(inputs.riskLevel)
  const { banditMaxMult, banditForceExplore } = computeBanditProtection(inputs.losses5d, inputs.total5d)
  const newVersion = (current.version ?? 0) + 1

  params = {
    confidence_threshold:  confidenceThreshold,
    pf_quality_mult:       pfQualityMult,
    sl_tp_override:        slTpOverride,
    bandit_max_mult:       banditMaxMult,
    bandit_force_explore:  banditForceExplore,
    computed_at:           new Date(Date.now() + 8 * 3600_000).toISOString(),
    market_risk_score:     inputs.riskScore,
    recent_accuracy_30d:   Math.round(inputs.accuracy30d * 100) / 100,
    version:               newVersion,
  }

  await setAdaptiveParams(env.KV, params)

  const summary = [
    `v${newVersion}`,
    `conf=${confidenceThreshold.toFixed(2)}`,
    `risk=${inputs.riskLevel}(${inputs.riskScore})`,
    `acc30d=${(inputs.accuracy30d * 100).toFixed(0)}%`,
    `bandit=${banditForceExplore ? 'explore!' : `maxMult=${banditMaxMult}`}`,
    slTpOverride ? `sl+${slTpOverride.sl_add}/tp+${slTpOverride.tp_add}` : 'sl/tp=default',
  ].join(' | ')

  console.log(`[AdaptiveEngine] Legacy: ${summary}`)
  return summary
}
