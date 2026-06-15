import { ACTIVE_9_ML_TEACHERS } from './multiStrategyPleRouter'

const D1_IN_CHUNK_SIZE = 40

export type RuntimeTeacherEvidenceStatus = 'loaded' | 'empty' | 'unavailable'

export interface RuntimeTeacherEvidenceTelemetry {
  status: RuntimeTeacherEvidenceStatus
  source: 'predictions_per_model_latest_verified_before_run_date'
  input_scope: 'previous_trading_day_or_latest_verified_teacher_cache'
  training_teacher_labels_scope: 'offline_ple_listwise_training_only'
  runtime_teacher_evidence_scope: 'daily_optional_historical_cache_not_same_day_l2_l3_dependency'
  run_date: string
  lookback_days: number
  verified_only: boolean
  requested_symbol_count: number
  row_count: number
  labeled_symbol_count: number
  missing_symbol_count: number
  label_count: number
  teacher_model_count: number
  error?: string
}

export interface RuntimeTeacherEvidenceLoadResult {
  labels: Record<string, Record<string, number>>
  telemetry: RuntimeTeacherEvidenceTelemetry
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeSymbol(value: unknown): string {
  return cleanText(value).toUpperCase()
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function normalizeTeacherScore(value: unknown): number | null {
  const n = finiteNumber(value)
  if (n == null) return null
  const scaled = n > 1 && n <= 100 ? n / 100 : n
  if (!Number.isFinite(scaled) || scaled < 0 || scaled > 1) return null
  return Math.round(scaled * 1000) / 1000
}

function rowTeacherScore(row: Record<string, unknown>): number | null {
  const direct = normalizeTeacherScore(row.direction_accuracy)
  if (direct != null) return direct
  const forecast = parseJsonObject(row.forecast_data)
  return normalizeTeacherScore(forecast?.rank_score)
}

function baseTelemetry(input: {
  runDate: string
  lookbackDays: number
  verifiedOnly: boolean
  requestedSymbolCount: number
}): RuntimeTeacherEvidenceTelemetry {
  return {
    status: 'empty',
    source: 'predictions_per_model_latest_verified_before_run_date',
    input_scope: 'previous_trading_day_or_latest_verified_teacher_cache',
    training_teacher_labels_scope: 'offline_ple_listwise_training_only',
    runtime_teacher_evidence_scope: 'daily_optional_historical_cache_not_same_day_l2_l3_dependency',
    run_date: input.runDate,
    lookback_days: input.lookbackDays,
    verified_only: input.verifiedOnly,
    requested_symbol_count: input.requestedSymbolCount,
    row_count: 0,
    labeled_symbol_count: 0,
    missing_symbol_count: input.requestedSymbolCount,
    label_count: 0,
    teacher_model_count: ACTIVE_9_ML_TEACHERS.length,
  }
}

export async function loadRuntimeTeacherEvidence(
  db: D1Database,
  symbols: string[],
  options: {
    runDate: string
    lookbackDays?: number
    verifiedOnly?: boolean
  },
): Promise<RuntimeTeacherEvidenceLoadResult> {
  const runDate = cleanText(options.runDate)
  const lookbackDays = Math.max(1, Math.round(finiteNumber(options.lookbackDays) ?? 30))
  const verifiedOnly = options.verifiedOnly !== false
  const requestedSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))]
  const telemetry = baseTelemetry({
    runDate,
    lookbackDays,
    verifiedOnly,
    requestedSymbolCount: requestedSymbols.length,
  })
  if (!runDate || !requestedSymbols.length) {
    return { labels: {}, telemetry }
  }

  const labels: Record<string, Record<string, number>> = {}
  let rowCount = 0
  try {
    for (let offset = 0; offset < requestedSymbols.length; offset += D1_IN_CHUNK_SIZE) {
      const chunk = requestedSymbols.slice(offset, offset + D1_IN_CHUNK_SIZE)
      const symbolPlaceholders = chunk.map(() => '?').join(',')
      const modelPlaceholders = ACTIVE_9_ML_TEACHERS.map(() => '?').join(',')
      const verifiedClause = verifiedOnly ? 'AND p.verified_at IS NOT NULL' : ''
      const result = await db.prepare(`
        SELECT s.symbol,
               p.model_name,
               p.direction_accuracy,
               p.forecast_data,
               p.prediction_date,
               p.generated_at,
               p.id
          FROM predictions p
          JOIN stocks s ON s.id = p.stock_id
         WHERE s.symbol IN (${symbolPlaceholders})
           AND p.model_name IN (${modelPlaceholders})
           AND p.model_name NOT LIKE '%::challenger'
           AND p.prediction_date < ?
           AND date(p.prediction_date) >= date(?, ?)
           ${verifiedClause}
         ORDER BY s.symbol ASC,
                  p.model_name ASC,
                  date(p.prediction_date) DESC,
                  p.generated_at DESC,
                  p.id DESC
      `).bind(
        ...chunk,
        ...ACTIVE_9_ML_TEACHERS,
        runDate,
        runDate,
        `-${lookbackDays} days`,
      ).all<Record<string, unknown>>()
      const rows = result.results ?? []
      rowCount += rows.length
      for (const row of rows) {
        const symbol = normalizeSymbol(row.symbol)
        const modelName = cleanText(row.model_name)
        if (!symbol || !ACTIVE_9_ML_TEACHERS.includes(modelName as typeof ACTIVE_9_ML_TEACHERS[number])) continue
        labels[symbol] ??= {}
        if (labels[symbol][modelName] != null) continue
        const score = rowTeacherScore(row)
        if (score == null) continue
        labels[symbol][modelName] = score
      }
    }
  } catch (error) {
    return {
      labels: {},
      telemetry: {
        ...telemetry,
        status: 'unavailable',
        error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      },
    }
  }

  const labeledSymbolCount = Object.values(labels).filter((value) => Object.keys(value).length > 0).length
  const labelCount = Object.values(labels).reduce((sum, value) => sum + Object.keys(value).length, 0)
  return {
    labels,
    telemetry: {
      ...telemetry,
      status: labelCount > 0 ? 'loaded' : 'empty',
      row_count: rowCount,
      labeled_symbol_count: labeledSymbolCount,
      missing_symbol_count: Math.max(0, requestedSymbols.length - labeledSymbolCount),
      label_count: labelCount,
    },
  }
}
