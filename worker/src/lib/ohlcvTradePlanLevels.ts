export interface OhlcvRow {
  date: string
  time?: string | null
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface OhlcvTradePlanLevels {
  latestClose: number
  support: number
  resistance: number
  confirmation: number
  volumeNode: number | null
  atr: number | null
  atrUpper: number | null
  atrLower: number | null
}

export type IntradayFibonacciSessionMode = 'calendar_day' | 'tw_futures_night_session'

export interface IntradayFibonacciLevels {
  sessionMode: IntradayFibonacciSessionMode
  sessionKey: string
  sessionHigh: number
  sessionLow: number
  range: number
  fib0: number
  fib236: number
  fib382: number
  fib50: number
  fib618: number
  fib786: number
  fib100: number
}

export type OhlcvEntryMode = 'breakout' | 'pullback'

export const DEFAULT_STRONG_BREAKOUT_CHASE_PCT = 0.018

export interface OhlcvEntryPlan {
  source: 'ohlcv'
  mode: OhlcvEntryMode
  entryPrice: number
  stopLoss: number
  target1: number
  target2: number
  latestClose: number
  resistance: number
  confirmation: number
  support: number
  atrDefense: number | null
  volumeNode: number | null
  buyReferenceLow: number
  buyReferenceHigh: number
  optimisticLow: number
  optimisticHigh: number
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

function normalizeTime(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  return digits.padStart(6, '0').slice(-6)
}

function timeNumber(value: unknown): number {
  const normalized = normalizeTime(value)
  return normalized == null ? 0 : Number(normalized)
}

function addOneCalendarDay(date: string): string {
  const [year, month, day] = date.split('-').map((part) => Number(part))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return date
  const dt = new Date(Date.UTC(year, month - 1, day))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

function priceText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'na'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function confirmationBuffer(resistance: number, atr: number | null): number {
  const minBuffer = resistance * 0.002
  const dynamicBuffer = atr == null ? resistance * 0.006 : atr * 0.15
  const maxBuffer = resistance * 0.012
  return Math.max(0.01, Math.min(Math.max(minBuffer, dynamicBuffer), maxBuffer))
}

function actionableSupport(window: OhlcvRow[]): number {
  const supportWindow = window.slice(-Math.min(20, window.length))
  return Math.min(...supportWindow.map((row) => row.low))
}

function resolveBuyReferenceZone(levels: OhlcvTradePlanLevels): { low: number; high: number } {
  const confirmationCeiling = Math.max(0, levels.confirmation - Math.max(0.01, levels.confirmation * 0.001))
  const candidates = [
    levels.atrLower,
    levels.volumeNode,
    levels.support,
  ]
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
    .filter((value) => value >= levels.support && value <= confirmationCeiling)
  const anchor = candidates.length > 0 ? Math.max(...candidates) : Math.min(levels.support, confirmationCeiling)
  const width = levels.atr == null
    ? anchor * 0.018
    : Math.min(Math.max(levels.atr * 0.55, anchor * 0.006), anchor * 0.025)
  const low = Math.max(levels.support, anchor - width / 2)
  const high = Math.min(confirmationCeiling, anchor + width / 2)
  return {
    low: round2(Math.min(low, high)),
    high: round2(Math.max(low, high)),
  }
}

function resolveOptimisticHigh(
  levels: OhlcvTradePlanLevels,
  strongBreakoutChasePct = DEFAULT_STRONG_BREAKOUT_CHASE_PCT,
): number {
  const chaseCeiling = levels.confirmation * (1 + strongBreakoutChasePct)
  const atrExtension = levels.atr == null
    ? levels.confirmation * strongBreakoutChasePct
    : levels.atr * 0.8
  return round2(Math.max(chaseCeiling, levels.confirmation + atrExtension, levels.resistance))
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
      time: normalizeTime(row?.time ?? row?.Time ?? row?.hhmmss),
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

export function resolveIntradayFibonacciSessionKey(
  row: Pick<OhlcvRow, 'date' | 'time'>,
  options: { sessionMode?: IntradayFibonacciSessionMode; nightStartTime?: number } = {},
): string {
  const sessionMode = options.sessionMode ?? 'calendar_day'
  if (sessionMode === 'calendar_day') return row.date
  const nightStart = options.nightStartTime ?? 150000
  return timeNumber(row.time) >= nightStart ? addOneCalendarDay(row.date) : row.date
}

export function buildIntradayFibonacciLevels(
  rows: OhlcvRow[],
  options: { sessionMode?: IntradayFibonacciSessionMode; nightStartTime?: number } = {},
): IntradayFibonacciLevels | null {
  const latest = rows[rows.length - 1]
  if (!latest) return null
  const sessionMode = options.sessionMode ?? 'calendar_day'
  const sessionKey = resolveIntradayFibonacciSessionKey(latest, options)
  const sessionRows = rows.filter((row) => resolveIntradayFibonacciSessionKey(row, options) === sessionKey)
  if (!sessionRows.length) return null
  const sessionHigh = Math.max(...sessionRows.map((row) => row.high))
  const sessionLow = Math.min(...sessionRows.map((row) => row.low))
  if (!Number.isFinite(sessionHigh) || !Number.isFinite(sessionLow) || sessionHigh < sessionLow) return null
  const range = sessionHigh - sessionLow
  const level = (ratio: number) => round2(sessionLow + range * ratio)
  return {
    sessionMode,
    sessionKey,
    sessionHigh: round2(sessionHigh),
    sessionLow: round2(sessionLow),
    range: round2(range),
    fib0: round2(sessionLow),
    fib236: level(0.236),
    fib382: level(0.382),
    fib50: level(0.5),
    fib618: level(0.618),
    fib786: level(0.786),
    fib100: round2(sessionHigh),
  }
}

export function formatIntradayFibonacciWatchPoint(levels: IntradayFibonacciLevels): string {
  return [
    'intraday_fibonacci:',
    `mode=${levels.sessionMode}`,
    `session=${levels.sessionKey}`,
    `low=${priceText(levels.sessionLow)}`,
    `high=${priceText(levels.sessionHigh)}`,
    `fib236=${priceText(levels.fib236)}`,
    `fib382=${priceText(levels.fib382)}`,
    `fib50=${priceText(levels.fib50)}`,
    `fib618=${priceText(levels.fib618)}`,
    `fib786=${priceText(levels.fib786)}`,
  ].join(' ')
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

export function buildOhlcvTradePlanLevels(rows: OhlcvRow[], lookback = 60): OhlcvTradePlanLevels | null {
  const window = rows.slice(-lookback)
  const latest = rows[rows.length - 1]
  if (!latest || window.length < 5) return null
  const atr = latestAtr(rows)
  const previousWindow = window.slice(0, -1)
  const priorWindow = previousWindow.length > 0 ? previousWindow : window
  const support = actionableSupport(window)
  const resistance = Math.max(...priorWindow.map((row) => row.high))
  const confirmation = resistance + confirmationBuffer(resistance, atr)
  return {
    latestClose: round2(latest.close),
    support: round2(support),
    resistance: round2(resistance),
    confirmation: round2(confirmation),
    volumeNode: volumeNode(window),
    atr,
    atrUpper: atr == null ? null : round2(latest.close + atr),
    atrLower: atr == null ? null : round2(latest.close - atr),
  }
}

export function resolveOhlcvEntryPlan(
  levels: OhlcvTradePlanLevels | null | undefined,
  options: { latestPrice?: number | string | null; strongBreakoutChasePct?: number } = {},
): OhlcvEntryPlan | null {
  if (!levels) return null
  const latest = positivePrice(options.latestPrice) ?? levels.latestClose
  const confirmation = levels.confirmation
  const resistance = levels.resistance
  const buyReference = resolveBuyReferenceZone(levels)
  const buyReferenceLow = buyReference.low
  const buyReferenceHigh = buyReference.high
  const optimisticHigh = resolveOptimisticHigh(levels, options.strongBreakoutChasePct)
  const mode: OhlcvEntryMode = latest >= confirmation ? 'breakout' : 'pullback'
  const entryPrice = mode === 'breakout' ? confirmation : buyReferenceHigh
  const stopAnchor = levels.atrLower == null
    ? levels.support
    : Math.min(levels.support, levels.atrLower)
  const stopLoss = stopAnchor < entryPrice ? stopAnchor : entryPrice * 0.97
  const target1 = mode === 'breakout' ? optimisticHigh : confirmation
  const target2Base = Math.max(optimisticHigh, target1)
  const target2 = levels.atr != null ? target2Base + levels.atr : target2Base

  return {
    source: 'ohlcv',
    mode,
    entryPrice: round2(entryPrice),
    stopLoss: round2(stopLoss),
    target1: round2(target1),
    target2: round2(target2),
    latestClose: round2(levels.latestClose),
    resistance: round2(resistance),
    confirmation: round2(confirmation),
    support: round2(levels.support),
    atrDefense: levels.atrLower == null ? null : round2(levels.atrLower),
    volumeNode: levels.volumeNode == null ? null : round2(levels.volumeNode),
    buyReferenceLow,
    buyReferenceHigh,
    optimisticLow: round2(confirmation),
    optimisticHigh,
  }
}

export function formatOhlcvTradePlanWatchPoint(plan: OhlcvEntryPlan): string {
  return [
    'ohlcv_trade_plan:',
    `mode=${plan.mode}`,
    `entry=${priceText(plan.entryPrice)}`,
    `buy_reference=${priceText(plan.buyReferenceLow)}~${priceText(plan.buyReferenceHigh)}`,
    `optimistic_range=${priceText(plan.optimisticLow)}~${priceText(plan.optimisticHigh)}`,
    `confirmation=${priceText(plan.confirmation)}`,
    `resistance=${priceText(plan.resistance)}`,
    `support=${priceText(plan.support)}`,
    `atr_defense=${priceText(plan.atrDefense)}`,
    `volume_node=${priceText(plan.volumeNode)}`,
  ].join(' ')
}

export async function batchLoadOhlcvTradePlanLevels(
  db: D1Database,
  stockIds: number[],
  asOfDate: string,
  lookback = 80,
): Promise<Map<number, OhlcvTradePlanLevels>> {
  const ids = [...new Set(stockIds.filter((id) => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT stock_id, date, open, high, low, close, volume, avg_price
      FROM stock_prices
     WHERE stock_id IN (${placeholders})
       AND date <= ?
       AND close IS NOT NULL
     ORDER BY stock_id, date DESC
  `).bind(...ids, asOfDate).all<any>()

  const byStock = new Map<number, any[]>()
  for (const row of results ?? []) {
    const stockId = Number(row.stock_id)
    if (!Number.isFinite(stockId)) continue
    const rows = byStock.get(stockId) ?? []
    if (rows.length < lookback) rows.push(row)
    byStock.set(stockId, rows)
  }

  const out = new Map<number, OhlcvTradePlanLevels>()
  for (const [stockId, rows] of byStock.entries()) {
    const normalized = normalizeOhlcvRows([...rows].reverse())
    const levels = buildOhlcvTradePlanLevels(normalized)
    if (levels) out.set(stockId, levels)
  }
  return out
}

export async function batchLoadOhlcvTradePlanLevelsBySymbol(
  db: D1Database,
  symbols: string[],
  asOfDate: string,
  lookback = 80,
): Promise<Map<string, OhlcvTradePlanLevels>> {
  const cleanSymbols = [...new Set(symbols.map((symbol) => String(symbol).trim()).filter(Boolean))]
  if (cleanSymbols.length === 0) return new Map()
  const placeholders = cleanSymbols.map(() => '?').join(',')
  const { results: stockRows } = await db.prepare(`
    SELECT id, symbol
      FROM stocks
     WHERE symbol IN (${placeholders})
  `).bind(...cleanSymbols).all<{ id: number; symbol: string }>()
  const stockIds = (stockRows ?? [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0)
  const levelsById = await batchLoadOhlcvTradePlanLevels(db, stockIds, asOfDate, lookback)
  const out = new Map<string, OhlcvTradePlanLevels>()
  for (const row of stockRows ?? []) {
    const levels = levelsById.get(Number(row.id))
    if (levels) out.set(String(row.symbol), levels)
  }
  return out
}
