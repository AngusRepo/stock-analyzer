import { twToday } from './dateUtils'
import type { Bindings } from '../types'
import { assertMarketDataReady, type MarketDataReadinessResult } from './marketDataReadiness'
import { readMarketRegimeState } from './marketRegimeState'
import { buildMarketRegimeFactorPacket, upsertMarketRegimeFactorPacket } from './marketRegimeFactorPacket'

function resolvePipelineRunDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return twToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid pipeline run date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

export interface PipelineTriggerOptions {
  prevalidatedEventChain?: boolean
}

const MARKET_RISK_LATEST_CACHE_KEYS = [
  'market:risk:latest',
  'market:risk:latest:v4-context',
  'market:risk:latest:v19-finlab-risk-detail',
]

async function clearMarketRiskLatestCaches(env: Bindings): Promise<void> {
  await Promise.allSettled(MARKET_RISK_LATEST_CACHE_KEYS.map((key) => env.KV.delete(key)))
}

export async function runMLAndRiskV2(
  env: Bindings,
  runDate?: string | null,
  options: PipelineTriggerOptions = {},
): Promise<string> {
  const twDate = resolvePipelineRunDate(runDate)
  if (options.prevalidatedEventChain) {
    await assertMarketDataReady(env.DB, twDate)
  } else {
    await assertEveningPipelineReady(env, twDate)
  }

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
      const shouldRecomputeRisk = twDate === twToday()
      const existingRisk = shouldRecomputeRisk
        ? null
        : await env.DB.prepare('SELECT * FROM market_risk WHERE date=? LIMIT 1').bind(twDate).first<any>()
      const existingRiskComplete = existingRisk
        && existingRisk.twii_close != null
        && existingRisk.twii_ma20 != null
        && existingRisk.twii_bias != null
        && existingRisk.twii_vol20 != null
      if (!shouldRecomputeRisk && existingRiskComplete) {
        console.log(`[ML V2] Market risk preserved for backfill date=${twDate}; skip current-market overwrite`)
        const regimeState = await readMarketRegimeState(env.KV).catch(() => null)
        const packet = await buildMarketRegimeFactorPacket(env.DB, existingRisk, regimeState)
        await upsertMarketRegimeFactorPacket(env.DB, packet)
        await clearMarketRiskLatestCaches(env)
        console.log(`[ML V2] Market regime factor packet refreshed from preserved row: ${packet.level} (${packet.score}/100) date=${packet.date}`)
      } else {
        const risk = await calcMarketRisk(
          env.DB,
          env.ANTHROPIC_API_KEY,
          env.ML_CONTROLLER_URL,
          env.ML_CONTROLLER_SECRET,
          env.GEMINI_API_KEY,
          twDate,
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
        const regimeState = await readMarketRegimeState(env.KV).catch(() => null)
        const packet = await buildMarketRegimeFactorPacket(env.DB, {
          date: risk.date,
          vix: risk.vix,
          vix_level: risk.vixLevel,
          twii_close: risk.twiiClose,
          twii_vol20: risk.twiiVol20,
          twii_ma20: risk.twiiMa20,
          twii_bias: risk.twiiBias,
          foreign_consecutive_sell: risk.foreignConsecutiveSell,
          foreign_net_5d: risk.foreignNet5d,
          margin_ratio: risk.marginRatio,
          limit_down_count: risk.limitDownCount,
          limit_down_pct: risk.limitDownPct,
          risk_score: risk.riskScore,
          risk_level: risk.riskLevel,
          risk_summary: risk.riskSummary,
        }, regimeState)
        await upsertMarketRegimeFactorPacket(env.DB, packet)
        await clearMarketRiskLatestCaches(env)
        console.log(`[ML V2] Market risk: ${packet.level} (${packet.score}/100) date=${risk.date}`)
      }
    } catch (e: any) {
      throw new Error(`market risk unavailable; pipeline blocked: ${e?.message ?? e}`)
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
      if (res.status === 409 && text.toLowerCase().includes('active execution')) {
        console.log(`[ML V2] Controller reports active execution for ${twDate}; preserving active-run contract`)
        return `LOCKED active execution for ${twDate}: ${text.slice(0, 220)}`
      }
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

export async function assertEveningPipelineReady(
  env: Bindings,
  twDate: string,
): Promise<MarketDataReadinessResult> {
  const ready = await assertMarketDataReady(env.DB, twDate)
  const queueLog = await env.KV.get(`scheduler:run:indicator-queue:${twDate}`, 'json') as {
    status?: string
    summary?: string
  } | null

  // Waiting belongs to the evening-chain queue finalizer. This guard only blocks
  // direct pipeline triggers from bypassing the event-driven dependency chain.
  if (!queueLog || queueLog.status !== 'success') {
    throw new Error(
      `indicator queue not complete for ${twDate}: status=${queueLog?.status ?? 'missing'}; ` +
      `summary=${queueLog?.summary ?? ''}`,
    )
  }

  const regimeLog = await env.KV.get(`scheduler:run:regime-compute:${twDate}`, 'json') as {
    status?: string
    summary?: string
  } | null
  if (!regimeLog || regimeLog.status !== 'success') {
    throw new Error(
      `regime-compute not complete for ${twDate}: status=${regimeLog?.status ?? 'missing'}; ` +
      `summary=${regimeLog?.summary ?? ''}`,
    )
  }

  return ready
}
