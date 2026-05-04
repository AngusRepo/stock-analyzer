import { getAdaptiveParams, setAdaptiveParams } from './adaptiveConfig'
import { summarizeSellOrderLosses } from './paperOrderAccounting'

interface AdaptiveEngineEnv {
  DB: D1Database
  KV: KVNamespace
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
}

async function queryAdaptiveInputs(env: { DB: D1Database }) {
  const riskRow = await env.DB.prepare(
    'SELECT risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 1',
  ).first<{ risk_score: number; risk_level: string }>()

  const accGlobal = await env.DB.prepare(`
    SELECT CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS avg_acc
    FROM model_accuracy
    WHERE period='30d' AND total_count >= 3
  `).first<{ avg_acc: number | null }>()

  const { results: rows30d } = await env.DB.prepare(`
    SELECT model_name,
           SUM(total_count) AS total_count,
           CASE WHEN SUM(total_count) > 0 AND SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END) > 0
                THEN SUM(COALESCE(profit_factor, 0) * total_count) / SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END)
                ELSE NULL END AS profit_factor
    FROM model_accuracy
    WHERE period='30d'
    GROUP BY model_name
  `).all<any>().catch(() => ({ results: [] as any[] }))

  const { results: rows90d } = await env.DB.prepare(`
    SELECT model_name,
           CASE WHEN SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END) > 0
                THEN SUM(COALESCE(profit_factor, 0) * total_count) / SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END)
                ELSE NULL END AS profit_factor
    FROM model_accuracy
    WHERE period='90d'
    GROUP BY model_name
  `).all<any>().catch(() => ({ results: [] as any[] }))

  const fiveDaysAgo = new Date(Date.now() + 8 * 3600_000 - 5 * 86_400_000).toISOString().slice(0, 10)
  const { results: recentSellRows } = await env.DB.prepare(`
    SELECT price, shares, commission, tax, note
    FROM paper_orders
    WHERE side='sell' AND created_at >= ?
  `).bind(fiveDaysAgo).all<any>().catch(() => ({ results: [] as any[] }))
  const recentOrders = summarizeSellOrderLosses(recentSellRows ?? [])

  return {
    riskScore: riskRow?.risk_score ?? 50,
    riskLevel: riskRow?.risk_level ?? 'medium',
    accuracy30d: accGlobal?.avg_acc ?? 0.6,
    rows30d: rows30d ?? [],
    rows90d: rows90d ?? [],
    losses5d: recentOrders.losses,
    total5d: recentOrders.total,
  }
}

export async function runAdaptiveUpdate(env: AdaptiveEngineEnv): Promise<string> {
  if (!env.ML_CONTROLLER_URL) {
    throw new Error('ML_CONTROLLER_URL is required for adaptive update; Worker local adaptive computation is disabled')
  }

  const inputs = await queryAdaptiveInputs(env)
  const current = await getAdaptiveParams(env.KV)
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const res = await fetch(`${env.ML_CONTROLLER_URL}/risk-assess`, {
    method: 'POST',
    headers,
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
  const params = data.adaptive_params
  if (!params || typeof params !== 'object') {
    throw new Error('Controller /risk-assess returned invalid adaptive_params')
  }

  const summary = data.summary ?? 'Controller OK'
  await setAdaptiveParams(env.KV, params)
  console.log(`[AdaptiveEngine] Controller: ${summary}`)
  return summary
}
