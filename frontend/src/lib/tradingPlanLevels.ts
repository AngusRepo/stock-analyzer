export interface OhlcvRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface AtrBandPoint {
  time: string
  upper: number
  lower: number
  atr: number
}

export interface TradingPlanLevels {
  latestClose: number
  support: number
  resistance: number
  confirmation: number
  volumeNode: number | null
  atrUpper: number | null
  atrLower: number | null
  ma20: number | null
  ma60: number | null
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function positivePrice(value: unknown): number | null {
  const n = finiteNumber(value)
  return n != null && n > 0 ? n : null
}

function rowVolume(row: any): number {
  return finiteNumber(row?.volume ?? row?.Trading_Volume ?? row?.trading_volume) ?? 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function normalizeOhlcvRows(rows: any[]): OhlcvRow[] {
  const normalized: OhlcvRow[] = []
  let previousClose: number | null = null
  for (const row of rows) {
    const close = positivePrice(row?.close ?? row?.avg_price)
    const date = String(row?.date ?? '').slice(0, 10)
    if (!date || close == null) continue
    const avg = positivePrice(row?.avg_price)
    const open = positivePrice(row?.open) ?? previousClose ?? avg ?? close
    const high = Math.max(positivePrice(row?.high) ?? close, open, close)
    const low = Math.min(positivePrice(row?.low) ?? close, open, close)
    normalized.push({
      date,
      open,
      high,
      low,
      close,
      volume: Math.max(0, rowVolume(row)),
    })
    previousClose = close
  }
  return normalized
}

export function simpleMovingAverage(rows: OhlcvRow[], period: number): number | null {
  if (rows.length < period) return null
  const closes = rows.slice(-period).map((row) => row.close)
  return round2(closes.reduce((sum, value) => sum + value, 0) / period)
}

function trueRange(row: OhlcvRow, previousClose: number): number {
  return Math.max(
    row.high - row.low,
    Math.abs(row.high - previousClose),
    Math.abs(row.low - previousClose),
  )
}

export function latestAtr(rows: OhlcvRow[], period = 14): number | null {
  if (rows.length < period + 1) return null
  const window = rows.slice(-period)
  const startIndex = rows.length - period
  const ranges = window.map((row, index) => trueRange(row, rows[startIndex + index - 1].close))
  return round2(ranges.reduce((sum, value) => sum + value, 0) / period)
}

export function buildAtrBandSeries(rows: OhlcvRow[], period = 14): AtrBandPoint[] {
  if (rows.length < period + 1) return []
  const out: AtrBandPoint[] = []
  for (let i = period; i < rows.length; i++) {
    const window = rows.slice(i - period + 1, i + 1)
    const ranges = window.map((row, index) => trueRange(row, rows[i - period + index].close))
    const atr = ranges.reduce((sum, value) => sum + value, 0) / period
    out.push({
      time: rows[i].date,
      upper: round2(rows[i].close + atr),
      lower: round2(rows[i].close - atr),
      atr: round2(atr),
    })
  }
  return out
}

export function volumeNode(rows: OhlcvRow[], binCount = 24): number | null {
  if (!rows.length) return null
  const low = Math.min(...rows.map((row) => row.low))
  const high = Math.max(...rows.map((row) => row.high))
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null
  const bins = Array.from({ length: binCount }, () => 0)
  const width = (high - low) / binCount
  for (const row of rows) {
    const typical = (row.high + row.low + row.close) / 3
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((typical - low) / width)))
    bins[idx] += row.volume
  }
  const maxVolume = Math.max(...bins)
  if (maxVolume <= 0) return null
  const index = bins.findIndex((value) => value === maxVolume)
  return round2(low + (index + 0.5) * width)
}

export function buildTradingPlanLevels(rows: OhlcvRow[], lookback = 60): TradingPlanLevels | null {
  const window = rows.slice(-lookback)
  const latest = rows[rows.length - 1]
  if (!latest || window.length < 5) return null
  const atr = latestAtr(rows)
  const support = Math.min(...window.map((row) => row.low))
  const resistance = Math.max(...window.map((row) => row.high))
  const previousWindow = window.slice(0, -1)
  const confirmationWindow = previousWindow.length > 0 ? previousWindow : window
  const confirmation = Math.max(...confirmationWindow.map((row) => row.high))
  return {
    latestClose: round2(latest.close),
    support: round2(support),
    resistance: round2(resistance),
    confirmation: round2(confirmation),
    volumeNode: volumeNode(window),
    atrUpper: atr == null ? null : round2(latest.close + atr),
    atrLower: atr == null ? null : round2(latest.close - atr),
    ma20: simpleMovingAverage(rows, 20),
    ma60: simpleMovingAverage(rows, 60),
  }
}
