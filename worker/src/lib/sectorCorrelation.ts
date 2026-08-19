import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadActiveCoreStockIdentities, loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'

const LOOKBACK_DAYS_TURNOVER = 60
const LOOKBACK_DAYS_CORR = 60
const D1_IN_CHUNK_SIZE = 40

type DomainEnv = Pick<Bindings, 'DB'> & Partial<Bindings>

type LeaderRow = {
  sector: string
  stock_id: number
  symbol: string
  avg_turnover: number
  rank: number
}

function chunks<T>(items: T[], size = D1_IN_CHUNK_SIZE): T[][] {
  const output: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) output.push(items.slice(offset, offset + size))
  return output
}

async function loadSectorLeaderRows(
  env: DomainEnv,
  sectors: string[],
): Promise<Array<{ sector: string; symbol: string }>> {
  const marketDb = databaseForDataDomain(env, 'market')
  const rows: Array<{ sector: string; symbol: string }> = []
  for (const chunk of chunks([...new Set(sectors.filter(Boolean))])) {
    const marks = chunk.map(() => '?').join(',')
    const result = await marketDb.prepare(`
      SELECT sector, symbol FROM sector_leaders
       WHERE sector IN (${marks}) ORDER BY sector, rank
    `).bind(...chunk).all<{ sector: string; symbol: string }>()
    rows.push(...(result.results ?? []))
  }
  return rows
}

export async function computeSectorLeaders(env: DomainEnv): Promise<{
  sectorCount: number
  leaderCount: number
}> {
  const identities = await loadActiveCoreStockIdentities(env)
  const eligible = [...identities.values()].filter((row) => String(row.sector ?? '').trim())
  const prices = await loadMarketPriceHistoryBySymbols(env, eligible.map((row) => row.symbol), {
    rowsPerSymbol: LOOKBACK_DAYS_TURNOVER * 2,
  })
  const bySymbol = new Map<string, Array<{ close: number; volume: number }>>()
  for (const row of prices) {
    const close = Number(row.close)
    const volume = Number(row.volume)
    if (!Number.isFinite(close) || !Number.isFinite(volume) || volume <= 0) continue
    const series = bySymbol.get(row.symbol) ?? []
    series.push({ close, volume })
    bySymbol.set(row.symbol, series)
  }

  const bySector = new Map<string, LeaderRow[]>()
  for (const identity of eligible) {
    const series = bySymbol.get(identity.symbol) ?? []
    if (series.length < 30) continue
    const avgTurnover = series.reduce((sum, row) => sum + row.close * row.volume, 0) / series.length
    const sector = String(identity.sector)
    const rows = bySector.get(sector) ?? []
    rows.push({ sector, stock_id: identity.id, symbol: identity.symbol, avg_turnover: avgTurnover, rank: 0 })
    bySector.set(sector, rows)
  }

  const leaders: LeaderRow[] = []
  for (const rows of bySector.values()) {
    rows.sort((a, b) => b.avg_turnover - a.avg_turnover)
    leaders.push(...rows.slice(0, 3).map((row, index) => ({ ...row, rank: index + 1 })))
  }
  if (!leaders.length) return { sectorCount: 0, leaderCount: 0 }

  const marketDb = databaseForDataDomain(env, 'market')
  await marketDb.prepare('DELETE FROM sector_leaders').run()
  const now = new Date().toISOString()
  const statements = leaders.map((row) => marketDb.prepare(`
    INSERT INTO sector_leaders (sector, rank, stock_id, symbol, avg_turnover_60d, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(row.sector, row.rank, row.stock_id, row.symbol, row.avg_turnover, now))
  for (const batch of chunks(statements, 50)) await marketDb.batch(batch)
  return { sectorCount: new Set(leaders.map((row) => row.sector)).size, leaderCount: leaders.length }
}

export async function ensureSectorLeadersForScreener(
  env: DomainEnv,
  sectors: string[],
): Promise<{ refreshed: boolean; sectorCount: number; leaderCount: number }> {
  const unique = [...new Set(sectors.filter(Boolean))]
  if (!unique.length) return { refreshed: false, sectorCount: 0, leaderCount: 0 }
  const existing = await loadSectorLeaderRows(env, unique)
  if (existing.length) {
    return {
      refreshed: false,
      sectorCount: new Set(existing.map((row) => row.sector)).size,
      leaderCount: existing.length,
    }
  }
  const computed = await computeSectorLeaders(env)
  return { refreshed: true, ...computed }
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 10) return 0
  const meanA = a.slice(0, n).reduce((sum, value) => sum + value, 0) / n
  const meanB = b.slice(0, n).reduce((sum, value) => sum + value, 0) / n
  let numerator = 0
  let sumA = 0
  let sumB = 0
  for (let index = 0; index < n; index++) {
    const da = a[index] - meanA
    const db = b[index] - meanB
    numerator += da * db
    sumA += da * da
    sumB += db * db
  }
  const denominator = Math.sqrt(sumA * sumB)
  return denominator === 0 ? 0 : numerator / denominator
}

function returnSeries(rows: Array<{ date: string; close: number }>): Map<string, number> {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  const output = new Map<string, number>()
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1].close
    if (previous > 0) output.set(sorted[index].date, (sorted[index].close - previous) / previous)
  }
  return output
}

export async function sectorLeaderBonus(
  env: DomainEnv,
  candidateSymbol: string,
  candidateSector: string | null,
  corrThreshold: number,
  bonusPoints: number,
): Promise<{ bonus: number; avgCorr: number | null; leaderCount: number }> {
  const result = await sectorLeaderBonusBatch(
    env,
    [{ symbol: candidateSymbol, sector: candidateSector }],
    corrThreshold,
    bonusPoints,
  )
  return result.get(candidateSymbol) ?? { bonus: 0, avgCorr: null, leaderCount: 0 }
}

export async function sectorLeaderBonusBatch(
  env: DomainEnv,
  candidates: Array<{ symbol: string; sector?: string | null }>,
  corrThreshold: number,
  bonusPoints: number,
): Promise<Map<string, { bonus: number; avgCorr: number | null; leaderCount: number }>> {
  const output = new Map<string, { bonus: number; avgCorr: number | null; leaderCount: number }>()
  const clean = candidates
    .map((row) => ({ symbol: String(row.symbol ?? '').trim(), sector: row.sector ?? null }))
    .filter((row) => row.symbol)
  for (const row of clean) output.set(row.symbol, { bonus: 0, avgCorr: null, leaderCount: 0 })
  const sectors = [...new Set(clean.map((row) => row.sector).filter(Boolean) as string[])]
  if (!clean.length || !sectors.length) return output

  let leaderRows = await loadSectorLeaderRows(env, sectors)
  if (!leaderRows.length) {
    const refresh = await ensureSectorLeadersForScreener(env, sectors)
    if (refresh.leaderCount > 0) leaderRows = await loadSectorLeaderRows(env, sectors)
  }
  const leadersBySector = new Map<string, string[]>()
  for (const row of leaderRows) {
    const leaders = leadersBySector.get(row.sector) ?? []
    if (leaders.length < 3) leaders.push(row.symbol)
    leadersBySector.set(row.sector, leaders)
  }

  const symbols = new Set(clean.map((row) => row.symbol))
  for (const leaders of leadersBySector.values()) for (const symbol of leaders) symbols.add(symbol)
  const prices = await loadMarketPriceHistoryBySymbols(env, [...symbols], { rowsPerSymbol: LOOKBACK_DAYS_CORR * 2 })
  const seriesBySymbol = new Map<string, Array<{ date: string; close: number }>>()
  for (const row of prices) {
    const close = Number(row.close)
    if (!Number.isFinite(close) || close <= 0) continue
    const series = seriesBySymbol.get(row.symbol) ?? []
    series.push({ date: row.date, close })
    seriesBySymbol.set(row.symbol, series)
  }
  const returnsBySymbol = new Map([...seriesBySymbol].map(([symbol, rows]) => [symbol, returnSeries(rows)]))

  for (const candidate of clean) {
    if (!candidate.sector) continue
    const leaders = (leadersBySector.get(candidate.sector) ?? [])
      .filter((symbol) => symbol !== candidate.symbol)
      .slice(0, 3)
    const candidateRows = seriesBySymbol.get(candidate.symbol) ?? []
    if (!leaders.length || candidateRows.length < LOOKBACK_DAYS_CORR) {
      output.set(candidate.symbol, { bonus: 0, avgCorr: null, leaderCount: leaders.length })
      continue
    }
    const candidateReturns = returnsBySymbol.get(candidate.symbol) ?? new Map<string, number>()
    const correlations: number[] = []
    for (const leader of leaders) {
      const leaderRowsForSymbol = seriesBySymbol.get(leader) ?? []
      if (leaderRowsForSymbol.length < LOOKBACK_DAYS_CORR) continue
      const leaderReturns = returnsBySymbol.get(leader) ?? new Map<string, number>()
      const a: number[] = []
      const b: number[] = []
      for (const [date, value] of candidateReturns) {
        const peer = leaderReturns.get(date)
        if (peer != null) {
          a.push(value)
          b.push(peer)
        }
      }
      const correlation = pearson(a, b)
      if (Number.isFinite(correlation)) correlations.push(correlation)
    }
    if (!correlations.length) {
      output.set(candidate.symbol, { bonus: 0, avgCorr: null, leaderCount: leaders.length })
      continue
    }
    const avgCorr = correlations.reduce((sum, value) => sum + value, 0) / correlations.length
    output.set(candidate.symbol, {
      bonus: avgCorr > corrThreshold ? bonusPoints : 0,
      avgCorr,
      leaderCount: leaders.length,
    })
  }
  return output
}