import type { Bindings } from '../types'
import { batchGetIntradayMonitoringOHLC } from './paperIntradayData'
import {
  assessS12IntradayStructureFromBaseBars,
  s12TimingPolicyFromEnv,
  type S12IntradayAssessment,
} from './s12IntradayStructure'
import { loadS12IntradayBaseBars } from './s12RuntimeBars'
import { persistS12StructureSnapshot } from './s12StructureSnapshots'
import {
  applyS12TwCalibrationArtifact,
  listApprovedS12TwCalibrationArtifacts,
  resolveS12TwCalibrationArtifact,
  type S12TwCalibrationArtifact,
} from './s12TwEquityCalibration'

export const S12_SETUP_WATCH_STATES = new Set([
  'waiting_1h_demand_zone',
  'waiting_15m_zone_touch',
  'waiting_sweep',
  'waiting_choch',
  'waiting_bos',
  'waiting_retest',
  'waiting_reaction',
])

export interface SetupWatchSeed {
  symbol: string
  source_trade_date: string
  state: string
  demand_zone_low: number | null
  demand_zone_high: number | null
}

export function isS12SetupWatchState(value: unknown): boolean {
  return S12_SETUP_WATCH_STATES.has(String(value ?? '').trim())
}

export function isSetupWatchNearDemandZone(
  seed: Pick<SetupWatchSeed, 'demand_zone_low' | 'demand_zone_high'>,
  currentPrice: number,
  proximityPct = 0.018,
): boolean {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false
  const low = Number(seed.demand_zone_low)
  const high = Number(seed.demand_zone_high)
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) return true
  return currentPrice >= low * (1 - proximityPct) && currentPrice <= high * (1 + proximityPct)
}

export async function loadSetupWatchSeeds(db: D1Database, today: string): Promise<SetupWatchSeed[]> {
  const { results } = await db.prepare(`
    WITH source_date AS (
      SELECT MAX(trade_date) AS trade_date
        FROM s12_structure_snapshots
       WHERE trade_date < ?
         AND source IN ('s12_candidate_snapshot', 's12_candidate_snapshot_reconstruction')
    ), latest AS (
      SELECT ss.*,
             ROW_NUMBER() OVER (
               PARTITION BY ss.symbol
               ORDER BY ss.updated_at DESC, ss.id DESC
             ) AS rn
        FROM s12_structure_snapshots ss
       WHERE ss.trade_date = (SELECT trade_date FROM source_date)
         AND ss.source IN ('s12_candidate_snapshot', 's12_candidate_snapshot_reconstruction')
         AND COALESCE(ss.invalidated, 0) = 0
         AND ss.ready = 0
         AND ss.state IN (
           'waiting_1h_demand_zone', 'waiting_15m_zone_touch',
           'waiting_sweep', 'waiting_choch', 'waiting_bos',
           'waiting_retest', 'waiting_reaction'
         )
         AND EXISTS (
           SELECT 1
             FROM daily_recommendations dr
            WHERE date(dr.date) = date(ss.trade_date)
              AND dr.symbol = ss.symbol
              AND json_valid(dr.score_components) = 1
              AND COALESCE(json_extract(dr.score_components, '$.eligibleForAllocation'), 1) = 1
              AND COALESCE(json_extract(dr.score_components, '$.reason'), '') <> 'formal_ml_gate_filtered'
         )
    )
    SELECT symbol, trade_date AS source_trade_date, state, demand_zone_low, demand_zone_high
      FROM latest
     WHERE rn = 1
       AND NOT EXISTS (
         SELECT 1
           FROM s12_structure_snapshots current_watch
          WHERE current_watch.trade_date = ?
            AND current_watch.symbol = latest.symbol
            AND current_watch.source = 's12_intraday_setup_watch'
            AND (
                 current_watch.ready = 1
              OR current_watch.invalidated = 1
              OR current_watch.updated_at >= datetime('now', '-10 minutes')
            )
       )
     ORDER BY symbol
     LIMIT 200
  `).bind(today, today).all<SetupWatchSeed>()
  return results ?? []
}

export interface S12SetupWatchSummary {
  status: 'ok' | 'empty' | 'skipped' | 'triggered' | 'running'
  source_trade_date: string | null
  watched: number
  near_zone: number
  assessed: number
  ready_for_formal_ev: number
  still_waiting: number
  errors: number
  run_id?: string | null
  execution_id?: string | null
}

function enabledFlag(value: unknown, fallback: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) },
    async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        await fn(items[index])
      }
    },
  )
  await Promise.all(workers)
}

function minuteBucketRunId(today: string): string {
  const tw = new Date(Date.now() + 8 * 3600_000).toISOString()
  return `s12-intraday-watch:${today}:${tw.slice(11, 16).replace(':', '')}`
}

async function triggerDurableSetupWatch(
  env: Bindings,
  today: string,
  symbols: string[],
): Promise<Pick<S12SetupWatchSummary, 'status' | 'run_id' | 'execution_id'>> {
  if (!env.ML_CONTROLLER_URL || !env.ML_CONTROLLER_SECRET) {
    throw new Error('s12_intraday_watch_controller_missing')
  }
  const chainRunId = minuteBucketRunId(today)
  const response = await fetch(`${env.ML_CONTROLLER_URL.replace(/\/$/, '')}/s12-structure/batch/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Controller-Token': env.ML_CONTROLLER_SECRET,
    },
    body: JSON.stringify({
      run_date: today,
      chain_run_id: chainRunId,
      source: 'intraday_watch',
      symbols,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({})) as any
  if (response.status === 409) {
    const detail = payload?.detail ?? payload
    return {
      status: 'running',
      run_id: detail?.run_id ?? chainRunId,
      execution_id: detail?.execution_id ?? null,
    }
  }
  if (!response.ok) {
    throw new Error(`s12_intraday_watch_trigger_${response.status}:${JSON.stringify(payload).slice(0, 300)}`)
  }
  return {
    status: 'triggered',
    run_id: payload?.run_id ?? chainRunId,
    execution_id: payload?.execution_id ?? null,
  }
}

export async function runS12IntradaySetupWatchBatch(
  env: Bindings,
  today: string,
  options: { symbols?: string[]; concurrency?: number } = {},
): Promise<S12SetupWatchSummary> {
  const requestedSymbols = new Set((options.symbols ?? []).map((value) => String(value).trim()))
  const allSeeds = await loadSetupWatchSeeds(env.DB, today)
  const seeds = requestedSymbols.size > 0
    ? allSeeds.filter((seed) => requestedSymbols.has(seed.symbol))
    : allSeeds
  if (!seeds.length) {
    return { status: 'empty', source_trade_date: null, watched: 0, near_zone: 0, assessed: 0, ready_for_formal_ev: 0, still_waiting: 0, errors: 0 }
  }
  const quotes = await batchGetIntradayMonitoringOHLC(seeds.map((row) => row.symbol), {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  const proximityPct = Math.max(0.002, Math.min(0.05, Number((env as any).S12_SETUP_WATCH_ZONE_PROXIMITY_PCT ?? 0.018)))
  const calibrationArtifacts = await listApprovedS12TwCalibrationArtifacts(env.DB).catch(() => [])
  let nearZone = 0
  let assessed = 0
  let ready = 0
  let stillWaiting = 0
  let errors = 0

  const nearSeeds = seeds.filter((seed) => {
    const quote = quotes.get(seed.symbol)
    const price = Number(quote?.last ?? 0)
    return Boolean(quote && isSetupWatchNearDemandZone(seed, price, proximityPct))
  })
  nearZone = nearSeeds.length
  await runBounded(nearSeeds, options.concurrency ?? 4, async (seed) => {
    const quote = quotes.get(seed.symbol)!
    const price = Number(quote.last ?? 0)
    try {
      const [bars, stock] = await Promise.all([
        loadS12IntradayBaseBars(env, seed.symbol, today, price, Number(quote.totalVolume ?? 0)),
        env.DB.prepare('SELECT market FROM stocks WHERE symbol = ? LIMIT 1').bind(seed.symbol).first<{ market?: string | null }>(),
      ])
      const assess = (calibration: S12TwCalibrationArtifact | null): S12IntradayAssessment => assessS12IntradayStructureFromBaseBars({
        symbol: seed.symbol,
        baseBars: bars.bars,
        fallback15mBars: bars.fallback15mBars,
        fallback1hBars: bars.fallback1hBars,
        fallback4hBars: bars.fallback4hBars,
        fallbackDailyBars: bars.fallbackDailyBars,
        nowMs: Date.now(),
        policy: applyS12TwCalibrationArtifact(s12TimingPolicyFromEnv(env as any), calibration),
        barDiagnostics: {
          ...bars.diagnostics,
          calibration_artifact_id: calibration?.artifactId ?? null,
          calibration_scope: calibration?.scope ?? null,
        },
        h4ReferenceDate: bars.diagnostics.previous_daily_context_date,
        h4ReferenceClose: quote.referencePrice ?? bars.diagnostics.previous_daily_raw_close,
      })
      const preliminary = assess(null)
      const calibration = resolveS12TwCalibrationArtifact(calibrationArtifacts, {
        entryCohort: preliminary.state === 'limited_takeover_ready' ? 'limited_takeover_ready' : 'reaction_ready',
        marketSegment: stock?.market ?? 'UNKNOWN',
        asOfDate: today,
      })
      const assessment = calibration ? assess(calibration) : preliminary
      assessed += 1
      if (assessment.ready) ready += 1
      else stillWaiting += 1
      await persistS12StructureSnapshot(env, {
        tradeDate: today,
        symbol: seed.symbol,
        assessment,
        source: 's12_intraday_setup_watch',
        side: 'buy',
        metadata: {
          source_trade_date: seed.source_trade_date,
          source_state: seed.state,
          lifecycle_lane: assessment.ready ? 'ready_for_formal_ev' : 'setup_watch',
          direct_execution_allowed: false,
          formal_ev_required: true,
          proximity_pct: proximityPct,
        },
      })
    } catch (error) {
      errors += 1
      console.warn(`[S12SetupWatch] ${seed.symbol} failed:`, error instanceof Error ? error.message : String(error))
    }
  })
  return {
    status: 'ok',
    source_trade_date: seeds[0]?.source_trade_date ?? null,
    watched: seeds.length,
    near_zone: nearZone,
    assessed,
    ready_for_formal_ev: ready,
    still_waiting: stillWaiting,
    errors,
  }
}

export async function runS12IntradaySetupWatch(env: Bindings, today: string): Promise<S12SetupWatchSummary> {
  const seeds = await loadSetupWatchSeeds(env.DB, today)
  if (!seeds.length) {
    return { status: 'empty', source_trade_date: null, watched: 0, near_zone: 0, assessed: 0, ready_for_formal_ev: 0, still_waiting: 0, errors: 0 }
  }
  const quotes = await batchGetIntradayMonitoringOHLC(seeds.map((row) => row.symbol), {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  const proximityPct = Math.max(0.002, Math.min(0.05, Number((env as any).S12_SETUP_WATCH_ZONE_PROXIMITY_PCT ?? 0.018)))
  const nearSymbols = seeds
    .filter((seed) => {
      const quote = quotes.get(seed.symbol)
      return Boolean(quote && isSetupWatchNearDemandZone(seed, Number(quote.last ?? 0), proximityPct))
    })
    .map((seed) => seed.symbol)
  if (!nearSymbols.length) {
    return {
      status: 'ok', source_trade_date: seeds[0]?.source_trade_date ?? null,
      watched: seeds.length, near_zone: 0, assessed: 0,
      ready_for_formal_ev: 0, still_waiting: 0, errors: 0,
    }
  }
  const durableEnabled = enabledFlag((env as any).S12_DURABLE_STRUCTURE_JOB_ENABLED, true)
  if (!durableEnabled) {
    return runS12IntradaySetupWatchBatch(env, today, { symbols: nearSymbols, concurrency: 4 })
  }
  const trigger = await triggerDurableSetupWatch(env, today, nearSymbols)
  return {
    status: trigger.status,
    source_trade_date: seeds[0]?.source_trade_date ?? null,
    watched: seeds.length,
    near_zone: nearSymbols.length,
    assessed: 0,
    ready_for_formal_ev: 0,
    still_waiting: 0,
    errors: 0,
    run_id: trigger.run_id,
    execution_id: trigger.execution_id,
  }
}
