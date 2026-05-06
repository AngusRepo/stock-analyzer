/**
 * #16 Sector leader correlation (dannyquant_tw 啟發, 2026-04-21)
 *
 * Weekly cron → computeSectorLeaders(): per sector, rank stocks by 60d avg
 *   turnover (close*volume), keep top 3, upsert sector_leaders table.
 *
 * Screener integration → sectorLeaderBonus(symbol, sector): compute 60d return
 *   correlation between candidate and its sector leaders (top 3), bonus when
 *   avg(corr) > threshold (KV-driven default 0.7).
 *
 * Rationale: 族群連動 is a persistent TW market edge (ETF/基金 tend to rotate
 *   sector-wide). Candidates correlated with sector leaders ride the same flow;
 *   uncorrelated candidates are either idiosyncratic plays or laggards.
 */

const LOOKBACK_DAYS_TURNOVER = 60
const LOOKBACK_DAYS_CORR = 60

/**
 * Compute top-3 stocks per sector by 60d avg turnover (close*volume).
 * Skips sectors with fewer than 3 stocks with sufficient data.
 */
export async function computeSectorLeaders(db: D1Database): Promise<{
  sectorCount: number
  leaderCount: number
}> {
  const now = new Date().toISOString()

  const { results } = await db.prepare(`
    WITH sector_avg AS (
      SELECT s.sector, s.id AS stock_id, s.symbol,
             AVG(sp.close * sp.volume) AS avg_turnover
      FROM stocks s
      JOIN stock_prices sp ON sp.stock_id = s.id
      WHERE s.sector IS NOT NULL AND s.sector != ''
        AND sp.date >= date('now', '-${LOOKBACK_DAYS_TURNOVER * 2} days')
        AND sp.close IS NOT NULL AND sp.volume IS NOT NULL AND sp.volume > 0
      GROUP BY s.sector, s.id, s.symbol
      HAVING COUNT(*) >= 30
    ),
    ranked AS (
      SELECT sector, stock_id, symbol, avg_turnover,
             ROW_NUMBER() OVER (PARTITION BY sector ORDER BY avg_turnover DESC) AS rnk
      FROM sector_avg
    )
    SELECT sector, stock_id, symbol, avg_turnover, rnk
    FROM ranked WHERE rnk <= 3
    ORDER BY sector, rnk
  `).all<{ sector: string; stock_id: number; symbol: string; avg_turnover: number; rnk: number }>()

  const rows = results ?? []
  if (!rows.length) {
    console.warn('[SectorLeaders] compute produced 0 rows')
    return { sectorCount: 0, leaderCount: 0 }
  }

  await db.prepare('DELETE FROM sector_leaders').run()
  const batch = rows.map(r => db.prepare(
    `INSERT INTO sector_leaders (sector, rank, stock_id, symbol, avg_turnover_60d, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(r.sector, r.rnk, r.stock_id, r.symbol, r.avg_turnover, now))
  for (let b = 0; b < batch.length; b += 50) {
    await db.batch(batch.slice(b, b + 50))
  }

  const sectors = new Set(rows.map(r => r.sector)).size
  console.log(`[SectorLeaders] computed ${rows.length} leaders across ${sectors} sectors`)
  return { sectorCount: sectors, leaderCount: rows.length }
}

/**
 * Pearson correlation of two numeric arrays (assumes aligned, no NaN).
 */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 10) return 0
  let sa = 0, sb = 0
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i] }
  const ma = sa / n, mb = sb / n
  let num = 0, da = 0, dbb = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb
    num += xa * xb; da += xa * xa; dbb += xb * xb
  }
  const den = Math.sqrt(da * dbb)
  return den === 0 ? 0 : num / den
}

/**
 * Compute sector-leader correlation bonus for one candidate.
 * Returns bonus points if avg corr with sector leaders > threshold, else 0.
 * Graceful-degrade: missing sector / no leaders / insufficient price rows → 0.
 */
export async function sectorLeaderBonus(
  db: D1Database,
  candidateSymbol: string,
  candidateSector: string | null,
  corrThreshold: number,
  bonusPoints: number,
): Promise<{ bonus: number; avgCorr: number | null; leaderCount: number }> {
  if (!candidateSector) return { bonus: 0, avgCorr: null, leaderCount: 0 }

  const { results: leaders } = await db.prepare(
    'SELECT symbol FROM sector_leaders WHERE sector = ? AND symbol != ? ORDER BY rank LIMIT 3'
  ).bind(candidateSector, candidateSymbol).all<{ symbol: string }>()
  if (!leaders?.length) return { bonus: 0, avgCorr: null, leaderCount: 0 }

  const allSymbols = [candidateSymbol, ...leaders.map(l => l.symbol)]
  const placeholders = allSymbols.map(() => '?').join(',')
  const { results: priceRows } = await db.prepare(
    `SELECT s.symbol, sp.date, sp.close
     FROM stock_prices sp
     JOIN stocks s ON sp.stock_id = s.id
     WHERE s.symbol IN (${placeholders})
       AND sp.date >= date('now', '-${LOOKBACK_DAYS_CORR * 2} days')
       AND sp.close IS NOT NULL
     ORDER BY s.symbol, sp.date`
  ).bind(...allSymbols).all<{ symbol: string; date: string; close: number }>()

  const seriesBySymbol = new Map<string, { date: string; close: number }[]>()
  for (const row of priceRows ?? []) {
    if (!seriesBySymbol.has(row.symbol)) seriesBySymbol.set(row.symbol, [])
    seriesBySymbol.get(row.symbol)!.push({ date: row.date, close: row.close })
  }

  const candSeries = seriesBySymbol.get(candidateSymbol)
  if (!candSeries || candSeries.length < LOOKBACK_DAYS_CORR) {
    return { bonus: 0, avgCorr: null, leaderCount: leaders.length }
  }

  const toReturns = (series: { date: string; close: number }[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 1; i < series.length; i++) {
      const r = (series[i].close - series[i - 1].close) / series[i - 1].close
      m.set(series[i].date, r)
    }
    return m
  }

  const candRet = toReturns(candSeries)
  const corrs: number[] = []
  for (const ldr of leaders) {
    const lSeries = seriesBySymbol.get(ldr.symbol)
    if (!lSeries || lSeries.length < LOOKBACK_DAYS_CORR) continue
    const lRet = toReturns(lSeries)
    const a: number[] = [], b: number[] = []
    for (const [date, rv] of candRet) {
      const lv = lRet.get(date)
      if (lv !== undefined) { a.push(rv); b.push(lv) }
    }
    const c = pearson(a, b)
    if (Number.isFinite(c)) corrs.push(c)
  }
  if (!corrs.length) return { bonus: 0, avgCorr: null, leaderCount: leaders.length }

  const avgCorr = corrs.reduce((s, x) => s + x, 0) / corrs.length
  const bonus = avgCorr > corrThreshold ? bonusPoints : 0
  return { bonus, avgCorr, leaderCount: leaders.length }
}

export async function sectorLeaderBonusBatch(
  db: D1Database,
  candidates: Array<{ symbol: string; sector?: string | null }>,
  corrThreshold: number,
  bonusPoints: number,
): Promise<Map<string, { bonus: number; avgCorr: number | null; leaderCount: number }>> {
  const output = new Map<string, { bonus: number; avgCorr: number | null; leaderCount: number }>()
  const cleanCandidates = candidates
    .map(c => ({ symbol: String(c.symbol || '').trim(), sector: c.sector || null }))
    .filter(c => c.symbol)
  for (const c of cleanCandidates) output.set(c.symbol, { bonus: 0, avgCorr: null, leaderCount: 0 })
  const sectors = [...new Set(cleanCandidates.map(c => c.sector).filter(Boolean) as string[])]
  if (!cleanCandidates.length || !sectors.length) return output

  const sectorPh = sectors.map(() => '?').join(',')
  const { results: leaderRows } = await db.prepare(
    `SELECT sector, symbol
       FROM sector_leaders
      WHERE sector IN (${sectorPh})
      ORDER BY sector, rank`
  ).bind(...sectors).all<{ sector: string; symbol: string }>()

  const leadersBySector = new Map<string, string[]>()
  for (const row of leaderRows ?? []) {
    if (!leadersBySector.has(row.sector)) leadersBySector.set(row.sector, [])
    const leaders = leadersBySector.get(row.sector)!
    if (leaders.length < 3) leaders.push(row.symbol)
  }

  const symbols = new Set(cleanCandidates.map(c => c.symbol))
  for (const leaders of leadersBySector.values()) {
    for (const symbol of leaders) symbols.add(symbol)
  }
  const allSymbols = [...symbols]
  if (!allSymbols.length) return output

  const symbolPh = allSymbols.map(() => '?').join(',')
  const { results: priceRows } = await db.prepare(
    `SELECT s.symbol, sp.date, sp.close
       FROM stock_prices sp
       JOIN stocks s ON sp.stock_id = s.id
      WHERE s.symbol IN (${symbolPh})
        AND sp.date >= date('now', '-${LOOKBACK_DAYS_CORR * 2} days')
        AND sp.close IS NOT NULL
      ORDER BY s.symbol, sp.date`
  ).bind(...allSymbols).all<{ symbol: string; date: string; close: number }>()

  const seriesBySymbol = new Map<string, { date: string; close: number }[]>()
  for (const row of priceRows ?? []) {
    if (!seriesBySymbol.has(row.symbol)) seriesBySymbol.set(row.symbol, [])
    seriesBySymbol.get(row.symbol)!.push({ date: row.date, close: row.close })
  }
  const returnsBySymbol = new Map<string, Map<string, number>>()
  const toReturns = (series: { date: string; close: number }[]): Map<string, number> => {
    const cached = new Map<string, number>()
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1].close
      if (prev > 0) cached.set(series[i].date, (series[i].close - prev) / prev)
    }
    return cached
  }
  for (const [symbol, series] of seriesBySymbol) {
    returnsBySymbol.set(symbol, toReturns(series))
  }

  for (const candidate of cleanCandidates) {
    if (!candidate.sector) continue
    const leaders = (leadersBySector.get(candidate.sector) ?? []).filter(symbol => symbol !== candidate.symbol).slice(0, 3)
    if (!leaders.length) continue
    const candSeries = seriesBySymbol.get(candidate.symbol)
    if (!candSeries || candSeries.length < LOOKBACK_DAYS_CORR) {
      output.set(candidate.symbol, { bonus: 0, avgCorr: null, leaderCount: leaders.length })
      continue
    }
    const candRet = returnsBySymbol.get(candidate.symbol)
    if (!candRet) continue
    const corrs: number[] = []
    for (const leader of leaders) {
      const leaderSeries = seriesBySymbol.get(leader)
      const leaderRet = returnsBySymbol.get(leader)
      if (!leaderSeries || leaderSeries.length < LOOKBACK_DAYS_CORR || !leaderRet) continue
      const a: number[] = []
      const b: number[] = []
      for (const [date, rv] of candRet) {
        const lv = leaderRet.get(date)
        if (lv !== undefined) {
          a.push(rv)
          b.push(lv)
        }
      }
      const corr = pearson(a, b)
      if (Number.isFinite(corr)) corrs.push(corr)
    }
    if (!corrs.length) {
      output.set(candidate.symbol, { bonus: 0, avgCorr: null, leaderCount: leaders.length })
      continue
    }
    const avgCorr = corrs.reduce((sum, value) => sum + value, 0) / corrs.length
    output.set(candidate.symbol, {
      bonus: avgCorr > corrThreshold ? bonusPoints : 0,
      avgCorr,
      leaderCount: leaders.length,
    })
  }
  return output
}
