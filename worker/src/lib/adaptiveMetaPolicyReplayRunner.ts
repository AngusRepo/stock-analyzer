import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export interface AdaptiveMetaPolicyReplayRow {
  date?: string | null
  stock_id?: string | null
  symbol?: string | null
  model_name?: string | null
  direction_correct?: number | boolean | null
  direction_accuracy?: number | string | null
  price_error_pct?: number | string | null
  actual_return_pct?: number | string | null
  trade_pnl_pct?: number | string | null
  rank_score?: number | string | null
  model_ic?: number | string | null
  coverage?: number | string | null
  prediction_dispersion?: number | string | null
  data_quality?: number | string | null
  market_breadth?: number | string | null
  sector_heat?: number | string | null
  liquidity?: number | string | null
  fill_quality?: number | string | null
  regime?: string | number | null
  volatility?: number | string | null
  market_risk?: number | string | null
  market_risk_score?: number | string | null
  market_segment?: string | null
  recommendation_lane?: string | null
  has_buy_signal?: number | boolean | null
}

export interface AdaptiveMetaPolicyReplayOptions {
  startDate?: string
  endDate?: string
  limit?: number
  minIcSamples?: number
  minWindows?: number
  neuralEpochs?: number
  persist?: boolean
  timeoutMs?: number
}

const ACTIVE_MODELS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
] as const

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function todayTw(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function daysAgoTw(days: number): string {
  return new Date(Date.now() + 8 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10)
}

export async function listAdaptiveMetaPolicyReplayRows(
  db: D1Database,
  options: Pick<AdaptiveMetaPolicyReplayOptions, 'startDate' | 'endDate' | 'limit'> = {},
): Promise<AdaptiveMetaPolicyReplayRow[]> {
  const limit = boundedInt(options.limit, 20000, 1, 50000)
  const placeholders = ACTIVE_MODELS.map(() => '?').join(', ')
  const clauses = [
    `p.model_name IN (${placeholders})`,
    'p.verified_at IS NOT NULL',
    'p.actual_return_pct IS NOT NULL',
  ]
  const binds: unknown[] = [...ACTIVE_MODELS]
  if (options.startDate) {
    clauses.push('date(p.prediction_date) >= date(?)')
    binds.push(options.startDate)
  }
  if (options.endDate) {
    clauses.push('date(p.prediction_date) <= date(?)')
    binds.push(options.endDate)
  }
  binds.push(limit)

  const { results } = await db.prepare(`
    WITH recent AS (
      SELECT p.*
        FROM predictions p
       WHERE ${clauses.join(' AND ')}
       ORDER BY date(p.prediction_date) DESC, p.stock_id DESC, p.model_name DESC
       LIMIT ?
    )
    SELECT
      p.prediction_date AS date,
      p.stock_id,
      s.symbol,
      p.model_name,
      p.direction_correct,
      p.direction_accuracy,
      p.price_error_pct,
      p.actual_return_pct,
      p.trade_pnl_pct,
      COALESCE(
        CASE WHEN json_valid(p.forecast_data) THEN json_extract(p.forecast_data, '$.rank_score') END,
        CASE WHEN json_valid(p.forecast_data) THEN json_extract(p.forecast_data, '$.ensemble_v2.avg_rank') END,
        p.direction_accuracy
      ) AS rank_score,
      p.market_risk_score,
      dr.market_segment,
      dr.recommendation_lane,
      dr.has_buy_signal,
      COALESCE(
        CASE WHEN json_valid(dr.ml_vote_summary) THEN json_extract(dr.ml_vote_summary, '$.ic_4w_avg') END,
        CASE WHEN json_valid(dr.ml_vote_summary) THEN json_extract(dr.ml_vote_summary, '$.model_ic') END,
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.model_ic') END
      ) AS model_ic,
      COALESCE(
        CASE WHEN json_valid(dr.ml_vote_summary) THEN json_extract(dr.ml_vote_summary, '$.coverage') END,
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.ml_coverage') END
      ) AS coverage,
      COALESCE(
        CASE WHEN json_valid(dr.ml_vote_summary) THEN json_extract(dr.ml_vote_summary, '$.dispersion.rawRankStd') END,
        CASE WHEN json_valid(dr.ml_vote_summary) THEN json_extract(dr.ml_vote_summary, '$.raw_rank_std') END,
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.prediction_dispersion') END
      ) AS prediction_dispersion,
      COALESCE(
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.data_quality') END,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.data_quality') END
      ) AS data_quality,
      COALESCE(
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.market_breadth') END,
        CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.market_breadth') END
      ) AS market_breadth,
      COALESCE(
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.sector_heat') END,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.sector_heat') END,
        CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.sector_heat') END
      ) AS sector_heat,
      COALESCE(
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.liquidity') END,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.liquidity_score') END,
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.liquidity') END
      ) AS liquidity,
      COALESCE(
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.fill_quality') END,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.fill_quality') END
      ) AS fill_quality,
      COALESCE(
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.regime') END,
        CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.regime') END
      ) AS regime,
      COALESCE(
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.volatility') END,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.volatility_score') END,
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.volatility') END
      ) AS volatility,
      COALESCE(
        p.market_risk_score,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.market_risk') END,
        CASE WHEN json_valid(dr.alpha_context) THEN json_extract(dr.alpha_context, '$.market_risk_score') END,
        CASE WHEN json_valid(dr.score_components) THEN json_extract(dr.score_components, '$.market_risk') END
      ) AS market_risk
    FROM recent p
    LEFT JOIN stocks s ON s.id = p.stock_id
    LEFT JOIN daily_recommendations dr
      ON dr.stock_id = p.stock_id
     AND dr.date = p.prediction_date
    ORDER BY date(p.prediction_date) ASC, p.stock_id ASC, p.model_name ASC
  `).bind(...binds).all<AdaptiveMetaPolicyReplayRow>()

  return results ?? []
}

type CoreReplayContextRow = {
  date?: string | null
  stock_id?: string | null
  market_segment?: string | null
  recommendation_lane?: string | null
  has_buy_signal?: number | boolean | null
  ml_vote_summary?: string | null
  score_components?: string | null
  alpha_context?: string | null
  alpha_allocation?: string | null
}

function parseRecord(value: unknown): Record<string, any> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function firstScalar(...values: unknown[]): string | number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export async function listAdaptiveMetaPolicyReplayRowsAcrossDomains(
  learningDb: D1Database,
  coreDb: D1Database,
  options: Pick<AdaptiveMetaPolicyReplayOptions, 'startDate' | 'endDate' | 'limit'> = {},
): Promise<AdaptiveMetaPolicyReplayRow[]> {
  const limit = boundedInt(options.limit, 20000, 1, 50000)
  const placeholders = ACTIVE_MODELS.map(() => '?').join(', ')
  const clauses = [
    `p.model_name IN (${placeholders})`,
    'p.verified_at IS NOT NULL',
    'p.actual_return_pct IS NOT NULL',
  ]
  const binds: unknown[] = [...ACTIVE_MODELS]
  if (options.startDate) {
    clauses.push('date(p.prediction_date) >= date(?)')
    binds.push(options.startDate)
  }
  if (options.endDate) {
    clauses.push('date(p.prediction_date) <= date(?)')
    binds.push(options.endDate)
  }
  binds.push(limit)

  const predictionResult = await learningDb.prepare(`
    WITH recent AS (
      SELECT p.*
        FROM predictions p
       WHERE ${clauses.join(' AND ')}
       ORDER BY date(p.prediction_date) DESC, p.stock_id DESC, p.model_name DESC
       LIMIT ?
    )
    SELECT
      p.prediction_date AS date,
      p.stock_id,
      p.model_name,
      p.direction_correct,
      p.direction_accuracy,
      p.price_error_pct,
      p.actual_return_pct,
      p.trade_pnl_pct,
      COALESCE(
        CASE WHEN json_valid(p.forecast_data) THEN json_extract(p.forecast_data, '$.rank_score') END,
        CASE WHEN json_valid(p.forecast_data) THEN json_extract(p.forecast_data, '$.ensemble_v2.avg_rank') END,
        p.direction_accuracy
      ) AS rank_score,
      p.market_risk_score
    FROM recent p
    ORDER BY date(p.prediction_date) ASC, p.stock_id ASC, p.model_name ASC
  `).bind(...binds).all<AdaptiveMetaPolicyReplayRow>()
  const predictions = predictionResult.results ?? []
  if (!predictions.length) return []

  const dates = [...new Set(predictions
    .map((row) => String(row.date ?? '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
  const recommendationSql = dates.length
    ? `SELECT date, stock_id, market_segment, recommendation_lane, has_buy_signal,
              ml_vote_summary, score_components, alpha_context, alpha_allocation
         FROM daily_recommendations
        WHERE date IN (${dates.map(() => '?').join(', ')})`
    : `SELECT date, stock_id, market_segment, recommendation_lane, has_buy_signal,
              ml_vote_summary, score_components, alpha_context, alpha_allocation
         FROM daily_recommendations WHERE 1=0`
  const [stockResult, recommendationResult] = await Promise.all([
    coreDb.prepare('SELECT id AS stock_id, symbol FROM stocks').all<{ stock_id?: string; symbol?: string | null }>(),
    coreDb.prepare(recommendationSql).bind(...dates).all<CoreReplayContextRow>(),
  ])
  const symbols = new Map((stockResult.results ?? []).map((row) => [String(row.stock_id ?? ''), row.symbol ?? null]))
  const recommendations = new Map((recommendationResult.results ?? []).map((row) => [
    `${String(row.date ?? '').slice(0, 10)}|${String(row.stock_id ?? '')}`,
    row,
  ]))

  return predictions.map((prediction) => {
    const stockId = String(prediction.stock_id ?? '')
    const date = String(prediction.date ?? '').slice(0, 10)
    const recommendation = recommendations.get(`${date}|${stockId}`)
    const vote = parseRecord(recommendation?.ml_vote_summary)
    const score = parseRecord(recommendation?.score_components)
    const alpha = parseRecord(recommendation?.alpha_context)
    const allocation = parseRecord(recommendation?.alpha_allocation)
    return {
      ...prediction,
      symbol: symbols.get(stockId) ?? null,
      market_segment: recommendation?.market_segment ?? null,
      recommendation_lane: recommendation?.recommendation_lane ?? null,
      has_buy_signal: recommendation?.has_buy_signal ?? null,
      model_ic: firstScalar(vote.ic_4w_avg, vote.model_ic, score.model_ic),
      coverage: firstScalar(vote.coverage, score.ml_coverage),
      prediction_dispersion: firstScalar(vote.dispersion?.rawRankStd, vote.raw_rank_std, score.prediction_dispersion),
      data_quality: firstScalar(score.data_quality, alpha.data_quality),
      market_breadth: firstScalar(alpha.market_breadth, allocation.market_breadth),
      sector_heat: firstScalar(score.sector_heat, alpha.sector_heat, allocation.sector_heat),
      liquidity: firstScalar(alpha.liquidity, alpha.liquidity_score, score.liquidity),
      fill_quality: firstScalar(score.fill_quality, alpha.fill_quality),
      regime: firstScalar(alpha.regime, allocation.regime),
      volatility: firstScalar(alpha.volatility, alpha.volatility_score, score.volatility),
      market_risk: firstScalar(prediction.market_risk_score, alpha.market_risk, alpha.market_risk_score, score.market_risk),
    }
  })
}
function replaySummary(report: Record<string, any>, sourceRows: number): string {
  const failedGates = Array.isArray(report.failed_gates)
    ? report.failed_gates.map(String).filter(Boolean)
    : Array.isArray(report.gates)
      ? report.gates.filter((gate: any) => gate && gate.passed === false).map((gate: any) => String(gate.name ?? 'unknown_gate'))
      : []
  const gates = Array.isArray(report.gates)
    ? report.gates.map((gate: any) => `${gate.name}:${gate.passed ? 'pass' : 'fail'}`).join(',')
    : 'gates=missing'
  const bestDelta = report.best_delta ?? report.best_reward_delta ?? report.candidate_delta ?? report.delta
  return [
    `adaptive_meta_replay status=${report.status ?? 'unknown'}`,
    `allowed_use=${report.allowed_use ?? 'unknown'}`,
    `allocator_candidate=${report.allocator_policy_candidate?.status ?? 'none'}`,
    `best=${report.best_ranked_method ?? 'none'}`,
    `recommended=${report.recommended_method ?? 'none'}`,
    `source_rows=${sourceRows}`,
    `windows=${report.sample_windows ?? 0}`,
    `failed_gates=${failedGates.length ? failedGates.join(',') : 'none'}`,
    bestDelta != null ? `best_delta=${bestDelta}` : null,
    `gates=${gates}`,
  ].filter(Boolean).join(' ')
}

export async function runAdaptiveMetaPolicyReplay(
  env: Pick<Bindings, 'DB' | 'KV' | 'ML_SERVICE_URL' | 'ML_SERVICE_SECRET'> & Partial<Bindings>,
  options: AdaptiveMetaPolicyReplayOptions = {},
): Promise<Record<string, any>> {
  const mlUrl = env.ML_SERVICE_URL?.trim()?.replace(/\/+$/, '')
  if (!mlUrl) throw new Error('ML_SERVICE_URL not set; cannot run adaptive meta-policy replay')

  const startDate = options.startDate ?? daysAgoTw(90)
  const endDate = options.endDate ?? todayTw()
  const learningDb = databaseForDataDomain(env, 'learning')
  const coreDb = databaseForDataDomain(env, 'core')
  const rowOptions = { startDate, endDate, limit: options.limit ?? 20000 }
  const rows = learningDb === coreDb
    ? await listAdaptiveMetaPolicyReplayRows(learningDb, rowOptions)
    : await listAdaptiveMetaPolicyReplayRowsAcrossDomains(learningDb, coreDb, rowOptions)

  const actualSourceDates = rows
    .map((row) => String(row.date ?? '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) headers['X-Service-Token'] = env.ML_SERVICE_SECRET
  const response = await fetch(`${mlUrl}/meta-learning/adaptive-policy-replay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rows,
      min_ic_samples: boundedInt(options.minIcSamples, 5, 1, 200),
      min_windows: boundedInt(options.minWindows, 8, 1, 260),
      neural_epochs: boundedInt(options.neuralEpochs, 80, 1, 1000),
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`ML service adaptive meta-policy replay HTTP ${response.status}: ${text.slice(0, 300)}`)
  }

  const report = await response.json() as Record<string, any>
  const failedGates = Array.isArray(report.failed_gates)
    ? report.failed_gates.map(String).filter(Boolean)
    : Array.isArray(report.gates)
      ? report.gates.filter((gate: any) => gate && gate.passed === false).map((gate: any) => String(gate.name ?? 'unknown_gate'))
      : []
  const evidence = {
    ...report,
    failed_gates: failedGates,
    gate_report: {
      failed_gates: failedGates,
      gates: Array.isArray(report.gates) ? report.gates : [],
      allowed_use: report.allowed_use ?? 'unknown',
      status: report.status ?? 'unknown',
      best_ranked_method: report.best_ranked_method ?? null,
      recommended_method: report.recommended_method ?? null,
      sample_windows: report.sample_windows ?? 0,
      candidate_delta: report.best_delta ?? report.best_reward_delta ?? report.candidate_delta ?? report.delta ?? null,
    },
    production_effect: false,
    mutation_allowed: false,
    real_trading_allowed: false,
    source_query: {
      start_date: startDate,
      end_date: endDate,
      actual_date_start: actualSourceDates[0] ?? null,
      actual_date_end: actualSourceDates.at(-1) ?? null,
      source_rows: rows.length,
      active_models: [...ACTIVE_MODELS],
    },
  }
  const persist = options.persist === true
  if (persist) {
    await env.KV.put('meta:adaptive_policy_replay:latest', JSON.stringify(evidence), { expirationTtl: 30 * 86400 })
    await env.KV.put(`meta:adaptive_policy_replay:${endDate}`, JSON.stringify(evidence), { expirationTtl: 180 * 86400 })
  }
  return {
    ...evidence,
    mode: persist ? 'persisted_evidence' : 'dry_run',
    summary: replaySummary(report, rows.length),
  }
}
