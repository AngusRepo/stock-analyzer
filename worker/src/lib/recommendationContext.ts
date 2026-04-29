export interface MlVoteSummary {
  bullish: number
  bearish: number
  flat: number
  reported: number
  missing: number
  total: number
  forecastPct: number | null
  activeWeightCount: number
  reason: string | null
}

export function parsePredictionForecastData(raw: unknown): Record<string, any> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, any>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function buildMlVoteSummary(forecastData: unknown): MlVoteSummary | null {
  const data = parsePredictionForecastData(forecastData)
  if (!data) return null

  const models = Array.isArray(data.models)
    ? data.models.filter((model: any) => String(model?.name ?? model?.model_name ?? '') !== 'StackingRank')
    : []
  const weights = data.ensemble_v2?.weights && typeof data.ensemble_v2.weights === 'object'
    ? data.ensemble_v2.weights as Record<string, unknown>
    : {}
  const total = Math.max(Object.keys(weights).length, models.length)
  if (total <= 0) return null

  let bullish = 0
  let bearish = 0
  let flat = 0
  for (const model of models) {
    const direction = String(model?.direction ?? model?.signal ?? '').toLowerCase()
    if (direction.includes('up') || direction.includes('buy') || direction.includes('bull')) bullish += 1
    else if (direction.includes('down') || direction.includes('sell') || direction.includes('bear')) bearish += 1
    else flat += 1
  }

  const forecastRaw = data.ensemble_v2?.forecast_pct ?? data.forecast_pct ?? null
  const forecastPct = typeof forecastRaw === 'number' && Number.isFinite(forecastRaw)
    ? Math.round(forecastRaw * 1000) / 1000
    : null
  const activeWeightCount = Object.values(weights).filter((value) => Number(value ?? 0) > 0).length

  return {
    bullish,
    bearish,
    flat,
    reported: models.length,
    missing: Math.max(0, total - models.length),
    total,
    forecastPct,
    activeWeightCount,
    reason: typeof data.ensemble_v2?.reason === 'string' ? data.ensemble_v2.reason : null,
  }
}

export function buildMlVoteWatchPoint(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const forecast = summary.forecastPct == null ? 'n/a' : summary.forecastPct.toFixed(1)
  return `ML ensemble: bullish=${summary.bullish}/${summary.total}, bearish=${summary.bearish}/${summary.total}, missing=${summary.missing}/${summary.total}, forecast=${forecast}%`
}

export function buildMarketStructureWatchPoint(alphaContext: any): string | null {
  const structure = alphaContext?.risk_overlay?.structure_detail
  if (!structure || typeof structure !== 'object') return null
  const poc = structure.poc_price
  const low = structure.fair_value_low
  const high = structure.fair_value_high
  const location = structure.price_location ?? 'unknown'
  if (poc == null && low == null && high == null && location === 'unknown') return null
  return `Market structure: POC=${poc ?? 'n/a'}, fair_value=${low ?? 'n/a'}~${high ?? 'n/a'}, location=${location}`
}

export function appendUniqueWatchPoint(points: string[], next: string | null): string[] {
  if (!next) return points
  const key = next.split(':', 1)[0]
  if (points.some((point) => point.startsWith(`${key}:`))) return points
  return [...points, next]
}
