export type PositionPriceRow = {
  symbol: string
  date: string
  close: number
}

export type PositionCorrelationAssessment = {
  status: 'pass' | 'blocked' | 'fallback_insufficient_data'
  candidate_symbol: string
  max_positive_correlation: number | null
  max_correlation_peer: string | null
  overlapping_returns: number
  threshold: number
  minimum_overlapping_returns: number
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function dailyReturnsBySymbol(rows: PositionPriceRow[]): Map<string, Map<string, number>> {
  const prices = new Map<string, Array<{ date: string; close: number }>>()
  for (const row of rows) {
    const symbol = String(row.symbol ?? '').trim()
    const date = String(row.date ?? '').slice(0, 10)
    const close = finitePositive(row.close)
    if (!symbol || !date || close == null) continue
    const series = prices.get(symbol) ?? []
    series.push({ date, close })
    prices.set(symbol, series)
  }

  const returns = new Map<string, Map<string, number>>()
  for (const [symbol, series] of prices) {
    series.sort((a, b) => a.date.localeCompare(b.date))
    const byDate = new Map<string, number>()
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1].close
      const current = series[index].close
      const value = current / previous - 1
      if (Number.isFinite(value) && value > -1) byDate.set(series[index].date, value)
    }
    returns.set(symbol, byDate)
  }
  return returns
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length
  let covariance = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean
    const rightDelta = right[index] - rightMean
    covariance += leftDelta * rightDelta
    leftVariance += leftDelta * leftDelta
    rightVariance += rightDelta * rightDelta
  }
  const denominator = Math.sqrt(leftVariance * rightVariance)
  if (!Number.isFinite(denominator) || denominator === 0) return null
  return Math.max(-1, Math.min(1, covariance / denominator))
}

export function assessPositionCorrelation(input: {
  candidateSymbol: string
  holdingSymbols: string[]
  priceRows: PositionPriceRow[]
  threshold: number
  minimumOverlappingReturns?: number
}): PositionCorrelationAssessment {
  const threshold = Math.max(0, Math.min(1, Number(input.threshold) || 0.7))
  const minimum = Math.max(5, Math.floor(input.minimumOverlappingReturns ?? 20))
  const candidate = String(input.candidateSymbol ?? '').trim()
  const peers = [...new Set(input.holdingSymbols.map((value) => String(value).trim()))]
    .filter((value) => value && value !== candidate)
  if (!peers.length) {
    return {
      status: 'pass', candidate_symbol: candidate, max_positive_correlation: null,
      max_correlation_peer: null, overlapping_returns: 0, threshold,
      minimum_overlapping_returns: minimum,
    }
  }

  const returns = dailyReturnsBySymbol(input.priceRows)
  const candidateReturns = returns.get(candidate)
  let assessedPeers = 0
  let maxCorrelation: number | null = null
  let maxPeer: string | null = null
  let maxOverlap = 0
  for (const peer of peers) {
    const peerReturns = returns.get(peer)
    if (!candidateReturns || !peerReturns) continue
    const dates = [...candidateReturns.keys()].filter((date) => peerReturns.has(date))
    if (dates.length < minimum) continue
    assessedPeers += 1
    const correlation = pearson(
      dates.map((date) => candidateReturns.get(date) as number),
      dates.map((date) => peerReturns.get(date) as number),
    )
    if (correlation == null) continue
    if (maxCorrelation == null || correlation > maxCorrelation) {
      maxCorrelation = correlation
      maxPeer = peer
      maxOverlap = dates.length
    }
  }

  const status = assessedPeers === 0
    ? 'fallback_insufficient_data'
    : maxCorrelation != null && maxCorrelation >= threshold
      ? 'blocked'
      : 'pass'
  return {
    status,
    candidate_symbol: candidate,
    max_positive_correlation: maxCorrelation == null ? null : Math.round(maxCorrelation * 10_000) / 10_000,
    max_correlation_peer: maxPeer,
    overlapping_returns: maxOverlap,
    threshold,
    minimum_overlapping_returns: minimum,
  }
}

export async function loadPositionPriceRows(
  db: D1Database,
  symbols: string[],
  window: number,
): Promise<PositionPriceRow[]> {
  const unique = [...new Set(symbols.map((value) => String(value).trim()))].filter(Boolean)
  if (!unique.length) return []
  const placeholders = unique.map(() => '?').join(',')
  const boundedWindow = Math.max(20, Math.min(260, Math.floor(window)))
  const { results } = await db.prepare(`
    SELECT symbol, date, close
      FROM (
        SELECT s.symbol, sp.date, sp.close,
               ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY sp.date DESC) AS rn
          FROM stock_prices sp
          JOIN stocks s ON s.id=sp.stock_id
         WHERE s.symbol IN (${placeholders}) AND sp.close>0
      )
     WHERE rn<=?
     ORDER BY symbol ASC, date ASC
  `).bind(...unique, boundedWindow + 1).all<PositionPriceRow>()
  return results ?? []
}
