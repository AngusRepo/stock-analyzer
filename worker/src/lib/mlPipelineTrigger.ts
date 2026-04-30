import { twToday } from './dateUtils'
import type { Bindings } from '../types'

function resolvePipelineRunDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return twToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid pipeline run date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

export async function runMLAndRiskV2(env: Bindings, runDate?: string | null): Promise<string> {
  const twDate = resolvePipelineRunDate(runDate)
  const lockKey = `lock:ml-predict:${twDate}`
  const existing = await env.KV.get(lockKey)
  if (existing) {
    console.log('[ML V2] Already running, skip')
    return 'LOCKED'
  }

  await env.KV.put(lockKey, '1', { expirationTtl: 1800 })

  try {
    if (!env.ML_CONTROLLER_URL) {
      throw new Error('ML_CONTROLLER_URL not set; cannot trigger pipeline V2')
    }

    try {
      const { calcMarketRisk } = await import('./marketRisk')
      const risk = await calcMarketRisk(
        env.DB,
        env.ANTHROPIC_API_KEY,
        env.ML_CONTROLLER_URL,
        env.ML_CONTROLLER_SECRET,
        env.GEMINI_API_KEY,
      )
      await env.DB.prepare(`
        INSERT OR REPLACE INTO market_risk
          (date, vix, vix_level, twii_close, twii_vol20, twii_ma20, twii_bias,
           foreign_consecutive_sell, foreign_net_5d, margin_ratio,
           limit_down_count, limit_down_pct, risk_score, risk_level, risk_summary)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        risk.date,
        risk.vix,
        risk.vixLevel,
        risk.twiiClose,
        risk.twiiVol20,
        risk.twiiMa20,
        risk.twiiBias,
        risk.foreignConsecutiveSell,
        risk.foreignNet5d,
        risk.marginRatio,
        risk.limitDownCount,
        risk.limitDownPct,
        risk.riskScore,
        risk.riskLevel,
        risk.riskSummary,
      ).run()
      await env.KV.delete('market:risk:latest')
      console.log(`[ML V2] Market risk: ${risk.riskLevel} (${risk.riskScore}/100)`)
    } catch (e) {
      console.error('[ML V2] Market risk failed (non-blocking):', e)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    console.log(`[ML V2] Triggering ml-controller /pipeline/v2/run date=${twDate} (async, expect 202)...`)
    const t0 = Date.now()
    const res = await fetch(`${env.ML_CONTROLLER_URL}/pipeline/v2/run?date=${twDate}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Pipeline V2 trigger HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    let runId = 'unknown'
    try {
      const body = await res.json() as any
      runId = String(body?.run_id ?? 'unknown')
    } catch {
      // ignore empty response body
    }

    console.log(`[ML V2] Triggered in ${elapsed}s, run_id=${runId} (awaiting callback for final status)`)
    return `triggered run_id=${runId}, callback expected`
  } catch (e: any) {
    await env.KV.delete(lockKey).catch(() => {})
    throw e
  }
}
