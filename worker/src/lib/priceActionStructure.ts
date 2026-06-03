import type { OhlcvRow } from './ohlcvTradePlanLevels'

export type PriceActionDirection = 'bullish'
export type PriceActionZoneStatus = 'untested' | 'retested' | 'filled' | 'invalidated'

export interface PriceActionStructureOptions {
  minGapPct?: number
  minDisplacementPct?: number
  breakLookback?: number
  orderBlockSearchBack?: number
  latestPrice?: number | null
}

export interface FairValueGapZone {
  type: 'fvg'
  direction: PriceActionDirection
  createdAt: string
  createdIndex: number
  low: number
  high: number
  gapPct: number
  displacementPct: number
  status: PriceActionZoneStatus
  strength: number
}

export interface OrderBlockZone {
  type: 'order_block'
  direction: PriceActionDirection
  createdAt: string
  createdIndex: number
  displacementAt: string
  displacementIndex: number
  low: number
  high: number
  bodyPct: number
  displacementPct: number
  status: PriceActionZoneStatus
  strength: number
}

export interface PriceActionStructure {
  version: 'price_action_structure_v1'
  fvgZones: FairValueGapZone[]
  orderBlockZones: OrderBlockZone[]
  bestFvg: FairValueGapZone | null
  bestOrderBlock: OrderBlockZone | null
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor + 1e-9) / factor
}

function round2(value: number): number {
  return round(value, 2)
}

function usableRows(rows: OhlcvRow[]): OhlcvRow[] {
  return rows.filter((row) => (
    finitePositive(row.open) != null &&
    finitePositive(row.high) != null &&
    finitePositive(row.low) != null &&
    finitePositive(row.close) != null &&
    row.high >= row.low
  ))
}

function bodyPct(row: OhlcvRow): number {
  return Math.abs(row.close - row.open) / Math.max(0.01, row.close)
}

function bullishDisplacementPct(row: OhlcvRow): number {
  return row.close > row.open ? (row.close - row.open) / Math.max(0.01, row.close) : 0
}

function zoneStatusAfter(
  zone: { low: number; high: number; createdIndex: number },
  rows: OhlcvRow[],
): PriceActionZoneStatus {
  let retested = false
  for (let idx = zone.createdIndex + 1; idx < rows.length; idx += 1) {
    const row = rows[idx]
    if (row.close < zone.low) return 'invalidated'
    if (row.low <= zone.low) return 'filled'
    if (row.low <= zone.high) retested = true
  }
  return retested ? 'retested' : 'untested'
}

function statusScore(status: PriceActionZoneStatus): number {
  if (status === 'retested') return 0.16
  if (status === 'untested') return 0.08
  if (status === 'filled') return -0.1
  return -0.3
}

function selectBestZone<T extends { low: number; high: number; status: PriceActionZoneStatus; strength: number }>(
  zones: T[],
  latestPrice: number | null,
): T | null {
  const live = zones.filter((zone) => zone.status !== 'invalidated' && zone.status !== 'filled')
  if (!live.length) return null
  return live
    .map((zone) => {
      const distancePenalty = latestPrice == null
        ? 0
        : Math.abs(latestPrice - zone.high) / Math.max(0.01, latestPrice)
      return { zone, score: zone.strength - distancePenalty }
    })
    .sort((a, b) => b.score - a.score)[0]?.zone ?? null
}

export function detectBullishFairValueGaps(
  inputRows: OhlcvRow[],
  options: PriceActionStructureOptions = {},
): FairValueGapZone[] {
  const rows = usableRows(inputRows)
  const minGapPct = Math.max(0, options.minGapPct ?? 0.001)
  const minDisplacementPct = Math.max(0, options.minDisplacementPct ?? 0.006)
  const zones: FairValueGapZone[] = []

  for (let idx = 2; idx < rows.length; idx += 1) {
    const left = rows[idx - 2]
    const displacement = rows[idx - 1]
    const current = rows[idx]
    const gapLow = left.high
    const gapHigh = current.low
    if (gapHigh <= gapLow) continue
    const gapPct = (gapHigh - gapLow) / Math.max(0.01, current.close)
    const displacementPct = bullishDisplacementPct(displacement)
    if (gapPct < minGapPct || displacementPct < minDisplacementPct) continue
    const status = zoneStatusAfter({ low: gapLow, high: gapHigh, createdIndex: idx }, rows)
    zones.push({
      type: 'fvg',
      direction: 'bullish',
      createdAt: current.date,
      createdIndex: idx,
      low: round2(gapLow),
      high: round2(gapHigh),
      gapPct: round(gapPct, 6),
      displacementPct: round(displacementPct, 6),
      status,
      strength: round(Math.min(1, gapPct * 30 + displacementPct * 12 + statusScore(status)), 6),
    })
  }

  return zones.sort((a, b) => b.strength - a.strength)
}

export function detectBullishOrderBlocks(
  inputRows: OhlcvRow[],
  options: PriceActionStructureOptions = {},
): OrderBlockZone[] {
  const rows = usableRows(inputRows)
  const minDisplacementPct = Math.max(0, options.minDisplacementPct ?? 0.006)
  const breakLookback = Math.max(3, Math.round(options.breakLookback ?? 8))
  const searchBack = Math.max(1, Math.round(options.orderBlockSearchBack ?? 5))
  const zones: OrderBlockZone[] = []

  for (let idx = breakLookback; idx < rows.length; idx += 1) {
    const displacement = rows[idx]
    const displacementPct = bullishDisplacementPct(displacement)
    if (displacementPct < minDisplacementPct) continue
    const priorWindow = rows.slice(Math.max(0, idx - breakLookback), idx)
    const priorHigh = Math.max(...priorWindow.map((row) => row.high))
    if (displacement.close <= priorHigh) continue
    const searchWindow = rows.slice(Math.max(0, idx - searchBack), idx).reverse()
    const ob = searchWindow.find((row) => row.close < row.open)
    if (!ob) continue
    const createdIndex = rows.indexOf(ob)
    const zoneLow = Math.min(ob.low, ob.open, ob.close)
    const zoneHigh = Math.max(ob.open, ob.close)
    if (zoneHigh <= zoneLow) continue
    const status = zoneStatusAfter({ low: zoneLow, high: zoneHigh, createdIndex: idx }, rows)
    zones.push({
      type: 'order_block',
      direction: 'bullish',
      createdAt: ob.date,
      createdIndex,
      displacementAt: displacement.date,
      displacementIndex: idx,
      low: round2(zoneLow),
      high: round2(zoneHigh),
      bodyPct: round(bodyPct(ob), 6),
      displacementPct: round(displacementPct, 6),
      status,
      strength: round(Math.min(1, displacementPct * 14 + bodyPct(ob) * 5 + statusScore(status)), 6),
    })
  }

  return zones.sort((a, b) => b.strength - a.strength)
}

export function buildPriceActionStructure(
  rows: OhlcvRow[],
  options: PriceActionStructureOptions = {},
): PriceActionStructure {
  const latestPrice = finitePositive(options.latestPrice) ?? finitePositive(rows[rows.length - 1]?.close)
  const fvgZones = detectBullishFairValueGaps(rows, options)
  const orderBlockZones = detectBullishOrderBlocks(rows, options)
  return {
    version: 'price_action_structure_v1',
    fvgZones,
    orderBlockZones,
    bestFvg: selectBestZone(fvgZones, latestPrice),
    bestOrderBlock: selectBestZone(orderBlockZones, latestPrice),
  }
}

export function formatPriceActionStructureWatchPoint(structure: PriceActionStructure): string {
  const ob = structure.bestOrderBlock
  const fvg = structure.bestFvg
  return [
    'price_action_structure_v1:',
    ob ? `order_block=${ob.low}~${ob.high}` : 'order_block=na',
    ob ? `order_block_status=${ob.status}` : null,
    fvg ? `fvg=${fvg.low}~${fvg.high}` : 'fvg=na',
    fvg ? `fvg_status=${fvg.status}` : null,
  ].filter(Boolean).join(' ')
}
