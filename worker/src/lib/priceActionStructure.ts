import type { OhlcvRow } from './ohlcvTradePlanLevels'

export type PriceActionDirection = 'bullish' | 'bearish'
export type PriceActionZoneStatus = 'untested' | 'retested' | 'filled' | 'invalidated'
export type SmcStructureBias = 'bullish' | 'bearish' | 'neutral'
export type SmcStructureBreakType = 'bos' | 'choch'

export interface PriceActionStructureOptions {
  minGapPct?: number
  minDisplacementPct?: number
  breakLookback?: number
  orderBlockSearchBack?: number
  structureLookback?: number
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

export interface SmcDisplacementCandle {
  direction: PriceActionDirection
  date: string
  index: number
  displacementPct: number
  bodyPct: number
  volumeRatio: number | null
  strength: number
}

export interface SmcLiquiditySweep {
  direction: PriceActionDirection
  date: string
  index: number
  sweptLevel: number
  close: number
  sweepPct: number
  displacementPct: number
  strength: number
}

export interface SmcStructureBreak {
  type: SmcStructureBreakType
  direction: PriceActionDirection
  date: string
  index: number
  brokenLevel: number
  close: number
  displacementPct: number
  strength: number
}

export interface SmcStructure {
  version: 'smc_structure_v1'
  bias: SmcStructureBias
  score: number
  bullishScore: number
  bearishScore: number
  latestSwingHigh: number | null
  latestSwingLow: number | null
  bullishLiquiditySweep: SmcLiquiditySweep | null
  bearishLiquiditySweep: SmcLiquiditySweep | null
  bullishBos: SmcStructureBreak | null
  bearishBos: SmcStructureBreak | null
  bullishChoch: SmcStructureBreak | null
  bearishChoch: SmcStructureBreak | null
  bullishDisplacement: SmcDisplacementCandle | null
  bearishDisplacement: SmcDisplacementCandle | null
}

export interface PriceActionStructure {
  version: 'price_action_structure_v1'
  fvgZones: FairValueGapZone[]
  orderBlockZones: OrderBlockZone[]
  bestFvg: FairValueGapZone | null
  bestOrderBlock: OrderBlockZone | null
  smc: SmcStructure
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

function bearishDisplacementPct(row: OhlcvRow): number {
  return row.close < row.open ? (row.open - row.close) / Math.max(0.01, row.close) : 0
}

function avg(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value))
  if (!clean.length) return null
  return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

function latestByIndex<T extends { index: number }>(items: T[], predicate: (item: T) => boolean): T | null {
  return [...items].reverse().find(predicate) ?? null
}

function recentStrength(event: { index: number; strength: number } | null, lastIndex: number, lookback: number): number {
  if (!event) return 0
  const age = Math.max(0, lastIndex - event.index)
  const decay = Math.max(0.45, 1 - age / Math.max(1, lookback * 1.5))
  return event.strength * decay
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

export function detectSmcStructure(
  inputRows: OhlcvRow[],
  options: PriceActionStructureOptions = {},
): SmcStructure {
  const rows = usableRows(inputRows)
  const minDisplacementPct = Math.max(0, options.minDisplacementPct ?? 0.006)
  const lookback = Math.max(5, Math.round(options.structureLookback ?? options.breakLookback ?? 20))
  const displacements: SmcDisplacementCandle[] = []
  const sweeps: SmcLiquiditySweep[] = []
  const breaks: SmcStructureBreak[] = []
  let lastBreakDirection: PriceActionDirection | null = null

  for (let idx = lookback; idx < rows.length; idx += 1) {
    const row = rows[idx]
    const priorWindow = rows.slice(Math.max(0, idx - lookback), idx)
    if (priorWindow.length < 3) continue
    const priorHigh = Math.max(...priorWindow.map((prior) => prior.high))
    const priorLow = Math.min(...priorWindow.map((prior) => prior.low))
    const priorAverageVolume = avg(priorWindow.map((prior) => Math.max(0, Number(prior.volume ?? 0))))
    const volume = Math.max(0, Number(row.volume ?? 0))
    const volumeRatio = priorAverageVolume && priorAverageVolume > 0 ? volume / priorAverageVolume : null
    const bullDisplacement = bullishDisplacementPct(row)
    const bearDisplacement = bearishDisplacementPct(row)

    if (bullDisplacement >= minDisplacementPct || bearDisplacement >= minDisplacementPct) {
      const direction: PriceActionDirection = bullDisplacement >= bearDisplacement ? 'bullish' : 'bearish'
      const displacementPct = direction === 'bullish' ? bullDisplacement : bearDisplacement
      displacements.push({
        direction,
        date: row.date,
        index: idx,
        displacementPct: round(displacementPct, 6),
        bodyPct: round(bodyPct(row), 6),
        volumeRatio: volumeRatio == null ? null : round(volumeRatio, 4),
        strength: round(Math.min(1, displacementPct * 16 + Math.max(0, (volumeRatio ?? 1) - 1) * 0.12), 6),
      })
    }

    if (row.low < priorLow && row.close > priorLow) {
      const sweepPct = (priorLow - row.low) / Math.max(0.01, row.close)
      sweeps.push({
        direction: 'bullish',
        date: row.date,
        index: idx,
        sweptLevel: round2(priorLow),
        close: round2(row.close),
        sweepPct: round(sweepPct, 6),
        displacementPct: round(bullDisplacement, 6),
        strength: round(Math.min(1, sweepPct * 25 + bullDisplacement * 10 + (row.close > row.open ? 0.08 : 0)), 6),
      })
    }

    if (row.high > priorHigh && row.close < priorHigh) {
      const sweepPct = (row.high - priorHigh) / Math.max(0.01, row.close)
      sweeps.push({
        direction: 'bearish',
        date: row.date,
        index: idx,
        sweptLevel: round2(priorHigh),
        close: round2(row.close),
        sweepPct: round(sweepPct, 6),
        displacementPct: round(bearDisplacement, 6),
        strength: round(Math.min(1, sweepPct * 25 + bearDisplacement * 10 + (row.close < row.open ? 0.08 : 0)), 6),
      })
    }

    const breakDisplacementFloor = Math.max(minDisplacementPct * 0.5, 0.002)
    if (row.close > priorHigh && bullDisplacement >= breakDisplacementFloor) {
      const type: SmcStructureBreakType = lastBreakDirection === 'bearish' ? 'choch' : 'bos'
      breaks.push({
        type,
        direction: 'bullish',
        date: row.date,
        index: idx,
        brokenLevel: round2(priorHigh),
        close: round2(row.close),
        displacementPct: round(bullDisplacement, 6),
        strength: round(Math.min(1, bullDisplacement * 14 + (volumeRatio != null && volumeRatio >= 1.2 ? 0.12 : 0)), 6),
      })
      lastBreakDirection = 'bullish'
    }

    if (row.close < priorLow && bearDisplacement >= breakDisplacementFloor) {
      const type: SmcStructureBreakType = lastBreakDirection === 'bullish' ? 'choch' : 'bos'
      breaks.push({
        type,
        direction: 'bearish',
        date: row.date,
        index: idx,
        brokenLevel: round2(priorLow),
        close: round2(row.close),
        displacementPct: round(bearDisplacement, 6),
        strength: round(Math.min(1, bearDisplacement * 14 + (volumeRatio != null && volumeRatio >= 1.2 ? 0.12 : 0)), 6),
      })
      lastBreakDirection = 'bearish'
    }
  }

  const lastIndex = rows.length - 1
  const bullishLiquiditySweep = latestByIndex(sweeps, (event) => event.direction === 'bullish')
  const bearishLiquiditySweep = latestByIndex(sweeps, (event) => event.direction === 'bearish')
  const bullishBos = latestByIndex(breaks, (event) => event.direction === 'bullish' && event.type === 'bos')
  const bearishBos = latestByIndex(breaks, (event) => event.direction === 'bearish' && event.type === 'bos')
  const bullishChoch = latestByIndex(breaks, (event) => event.direction === 'bullish' && event.type === 'choch')
  const bearishChoch = latestByIndex(breaks, (event) => event.direction === 'bearish' && event.type === 'choch')
  const bullishDisplacement = latestByIndex(displacements, (event) => event.direction === 'bullish')
  const bearishDisplacement = latestByIndex(displacements, (event) => event.direction === 'bearish')
  const latestWindow = rows.slice(Math.max(0, rows.length - lookback), rows.length)
  const latestSwingHigh = latestWindow.length ? round2(Math.max(...latestWindow.map((row) => row.high))) : null
  const latestSwingLow = latestWindow.length ? round2(Math.min(...latestWindow.map((row) => row.low))) : null
  const bullishScore = Math.min(1,
    recentStrength(bullishLiquiditySweep, lastIndex, lookback) * 0.35 +
    recentStrength(bullishBos, lastIndex, lookback) * 0.32 +
    recentStrength(bullishChoch, lastIndex, lookback) * 0.45 +
    recentStrength(bullishDisplacement, lastIndex, lookback) * 0.2)
  const bearishScore = Math.min(1,
    recentStrength(bearishLiquiditySweep, lastIndex, lookback) * 0.35 +
    recentStrength(bearishBos, lastIndex, lookback) * 0.32 +
    recentStrength(bearishChoch, lastIndex, lookback) * 0.45 +
    recentStrength(bearishDisplacement, lastIndex, lookback) * 0.2)
  const score = round(bullishScore - bearishScore, 6)
  const bias: SmcStructureBias = score >= 0.08 ? 'bullish' : score <= -0.08 ? 'bearish' : 'neutral'

  return {
    version: 'smc_structure_v1',
    bias,
    score,
    bullishScore: round(bullishScore, 6),
    bearishScore: round(bearishScore, 6),
    latestSwingHigh,
    latestSwingLow,
    bullishLiquiditySweep,
    bearishLiquiditySweep,
    bullishBos,
    bearishBos,
    bullishChoch,
    bearishChoch,
    bullishDisplacement,
    bearishDisplacement,
  }
}

export function buildPriceActionStructure(
  rows: OhlcvRow[],
  options: PriceActionStructureOptions = {},
): PriceActionStructure {
  const latestPrice = finitePositive(options.latestPrice) ?? finitePositive(rows[rows.length - 1]?.close)
  const fvgZones = detectBullishFairValueGaps(rows, options)
  const orderBlockZones = detectBullishOrderBlocks(rows, options)
  const smc = detectSmcStructure(rows, options)
  return {
    version: 'price_action_structure_v1',
    fvgZones,
    orderBlockZones,
    bestFvg: selectBestZone(fvgZones, latestPrice),
    bestOrderBlock: selectBestZone(orderBlockZones, latestPrice),
    smc,
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
    `smc_bias=${structure.smc.bias}`,
    `smc_score=${structure.smc.score}`,
    structure.smc.bullishLiquiditySweep ? `bull_sweep=${structure.smc.bullishLiquiditySweep.sweptLevel}` : null,
    structure.smc.bullishBos ? `bull_bos=${structure.smc.bullishBos.brokenLevel}` : null,
    structure.smc.bullishChoch ? `bull_choch=${structure.smc.bullishChoch.brokenLevel}` : null,
  ].filter(Boolean).join(' ')
}
