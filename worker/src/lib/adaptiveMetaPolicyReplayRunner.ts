import type { Bindings } from '../types'

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
  'TimesFM',
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
    FROM predictions p
    LEFT JOIN stocks s ON s.id = p.stock_id
    LEFT JOIN daily_recommendations dr
      ON dr.stock_id = p.stock_id
     AND dr.date = p.prediction_date
    WHERE ${clauses.join(' AND ')}
    ORDER BY date(p.prediction_date) ASC, p.stock_id ASC, p.model_name ASC
    LIMIT ?
  `).bind(...binds).all<AdaptiveMetaPolicyReplayRow>()

  return results ?? []
}

function replaySummary(report: Record<string, any>, sourceRows: number): string {
  const gates = Array.isArray(report.gates)
    ? report.gates.map((gate: any) => `${gate.name}:${gate.passed ? 'pass' : 'fail'}`).join(',')
    : 'gates=missing'
  return [
    `adaptive_meta_replay status=${report.status ?? 'unknown'}`,
    `allowed_use=${report.allowed_use ?? 'unknown'}`,
    `allocator_candidate=${report.allocator_policy_candidate?.status ?? 'none'}`,
    `best=${report.best_ranked_method ?? 'none'}`,
    `recommended=${report.recommended_method ?? 'none'}`,
    `source_rows=${sourceRows}`,
    `windows=${report.sample_windows ?? 0}`,
    `gates=${gates}`,
  ].join(' ')
}

export async function runAdaptiveMetaPolicyReplay(
  env: Pick<Bindings, 'DB' | 'KV' | 'ML_SERVICE_URL' | 'ML_SERVICE_SECRET'>,
  options: AdaptiveMetaPolicyReplayOptions = {},
): Promise<Record<string, any>> {
  const mlUrl = env.ML_SERVICE_URL?.trim()?.replace(/\/+$/, '')
  if (!mlUrl) throw new Error('ML_SERVICE_URL not set; cannot run adaptive meta-policy replay')

  const startDate = options.startDate ?? daysAgoTw(90)
  const endDate = options.endDate ?? todayTw()
  const rows = await listAdaptiveMetaPolicyReplayRows(env.DB, {
    startDate,
    endDate,
    limit: options.limit ?? 20000,
  })

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
  const evidence = {
    ...report,
    production_effect: false,
    mutation_allowed: false,
    real_trading_allowed: false,
    source_query: {
      start_date: startDate,
      end_date: endDate,
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
