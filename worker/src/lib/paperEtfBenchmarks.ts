// Benchmark marks for /api/paper/pnl. 00631L split 1:22 on 2026-03-25..03-30 (close 443.15 ->
// 19.26) and the raw close made it read -93% on the /bot equity chart. Marks use adj_close only:
// a missing adj_close stays missing instead of falling back to close, because mixing the two
// scales in one series recreates the jump. 0050 is loaded here too (etf_benchmarks['0050']) on
// the same basis; the chart still reads 0050 from paper_daily_snapshots.benchmark_value (a raw
// close) until it switches to this field, so 0050 stays price-return there for now.

export const PAPER_EXTRA_BENCHMARK_SYMBOLS = ['00981A', '00631L', '00403A'] as const
export const PAPER_ADJUSTED_BENCHMARK_SYMBOLS = ['0050', ...PAPER_EXTRA_BENCHMARK_SYMBOLS] as const
export const PAPER_BENCHMARK_PRICE_BASIS = 'adj_close' as const

export type BenchmarkPriceMap = Record<string, Record<string, number>>

// D1 permits at most 100 bound parameters: 90 dates + 4 benchmark ids stays below it.
const DATE_CHUNK = 90

// adj_close of each snapshot row's valuation session (the same session runDailySnapshot marks
// 0050 and TWII on: the row date, or the previous trading day when the row date is a weekend or a
// holiday:YYYY-MM-DD closure). The previous shape joined stock_prices on
// stock_id IN (...) and filtered sp.date against a correlated MAX(date), so every call walked
// each benchmark's whole price history (insights 2026-11-25: ~70-80K market rows per /pnl,
// 4.7M rows/day). Here each (date, stock) pair is one (stock_id, date) primary-key lookup.
// A date without its own adj_close (not yet ingested, halted, or never adjusted) stays missing:
// no D-1 carry, so a late adj_close never shows yesterday's mark as today's (AUD-20). Plan
// locked by paperEtfBenchmarks.test.ts.
export const PAPER_ETF_BENCHMARK_SQL = (dateCount: number, stockCount: number) => `
      WITH target_dates(date) AS (VALUES ${Array.from({ length: dateCount }, () => '(?)').join(',')}),
      target_stocks(stock_id) AS (VALUES ${Array.from({ length: stockCount }, () => '(?)').join(',')})
      SELECT d.date AS snapshot_date,
             s.stock_id,
             sp.date IS NOT NULL AS has_row,
             sp.adj_close
        FROM target_dates d
        CROSS JOIN target_stocks s
        LEFT JOIN stock_prices sp
          ON sp.stock_id = s.stock_id
         AND sp.date = d.date
       ORDER BY d.date ASC, s.stock_id ASC
    `

// Closure lookups. holiday:YYYY-MM-DD is the only source that also records ad-hoc closures (the
// 2026-07-10 typhoon closure is there; market:twse_holiday_schedule:v2:2026 read 2026-11-26 holds
// 0 dates), so it is read per day, but only for weekday rows where no benchmark has a price row
// (a price row proves the date traded). That is a handful of dates, not one per snapshot row, and
// it is capped so a long outage of price data cannot approach the 1,000 KV operations per call.
// A recorded closure does not go away, so only `true` is remembered per isolate; a KV failure
// counts as a trading day for that call (the row date is used) and is not remembered.
const closedDates = new Set<string>()
const SESSION_LOOKBACK_DAYS = 14
export const PAPER_CLOSURE_LOOKUP_CAP = 60

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday === 0 || weekday === 6
}

type ClosureReader = (date: string) => Promise<boolean>

function closureReader(kv: Pick<KVNamespace, 'get'>, traded: ReadonlySet<string>): { closed: ClosureReader; lookups: () => number } {
  let lookups = 0
  const closed: ClosureReader = async (date) => {
    if (isWeekend(date)) return true
    if (traded.has(date)) return false
    if (closedDates.has(date)) return true
    if (lookups >= PAPER_CLOSURE_LOOKUP_CAP) return false
    lookups += 1
    try {
      if (await kv.get(`holiday:${date}`)) {
        closedDates.add(date)
        return true
      }
    } catch (error) {
      console.warn('[paper/pnl] holiday lookup failed; treating the date as a trading day', date, error)
    }
    return false
  }
  return { closed, lookups: () => lookups }
}

/**
 * Valuation session per row date, as runDailySnapshot derives it (weekend or holiday:YYYY-MM-DD ->
 * previous weekday that is not a holiday, up to 14 days back). Without KV the row date is used.
 */
export async function paperValuationSessions(
  kv: Pick<KVNamespace, 'get'> | null | undefined,
  dates: string[],
  /** Dates already known to have traded (a benchmark price row exists): no KV read. */
  traded: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const clean = Array.from(new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))))
  if (!kv) {
    for (const date of clean) out.set(date, date)
    return out
  }
  const { closed } = closureReader(kv, traded)
  for (const date of clean) {
    if (!await closed(date)) { out.set(date, date); continue }
    let session = shiftDay(date, -1)
    for (let back = 1; back <= SESSION_LOOKBACK_DAYS && await closed(session); back += 1) session = shiftDay(session, -1)
    out.set(date, session)
  }
  return out
}

/** Test-only. */
export function resetPaperValuationSessionMemory(): void {
  closedDates.clear()
}

type PriceRows = Map<string, { anyRow: boolean; marks: Record<string, number> }>

async function readMarks(marketDb: D1Database, dates: string[], stockIds: number[], symbolByStockId: Map<number, string>): Promise<PriceRows> {
  const out: PriceRows = new Map()
  for (let index = 0; index < dates.length; index += DATE_CHUNK) {
    const dateChunk = dates.slice(index, index + DATE_CHUNK)
    const rows = await marketDb.prepare(PAPER_ETF_BENCHMARK_SQL(dateChunk.length, stockIds.length))
      .bind(...dateChunk, ...stockIds)
      .all<{ snapshot_date: string; stock_id: number; has_row: number; adj_close: number | null }>()
    for (const row of rows.results ?? []) {
      const entry = out.get(row.snapshot_date) ?? { anyRow: false, marks: {} }
      out.set(row.snapshot_date, entry)
      if (Number(row.has_row) === 1) entry.anyRow = true
      const value = Number(row.adj_close)
      const symbol = symbolByStockId.get(Number(row.stock_id))
      if (!symbol || row.adj_close == null || !Number.isFinite(value) || value <= 0) continue
      entry.marks[symbol] = value
    }
  }
  return out
}

export async function loadPaperEtfBenchmarks(
  coreDb: D1Database,
  marketDb: D1Database,
  dates: string[],
  symbols: readonly string[] = PAPER_ADJUSTED_BENCHMARK_SYMBOLS,
  kv?: Pick<KVNamespace, 'get'> | null,
): Promise<BenchmarkPriceMap> {
  const rowDates = Array.from(new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))).sort()
  const out: BenchmarkPriceMap = {}
  if (!rowDates.length || !symbols.length) return out

  const identities = await coreDb.prepare(`
    SELECT id, symbol
      FROM stocks
     WHERE symbol IN (${symbols.map(() => '?').join(',')})
  `).bind(...symbols).all<{ id: number; symbol: string }>()
  const symbolByStockId = new Map<number, string>()
  for (const row of identities.results ?? []) {
    const stockId = Number(row.id)
    if (Number.isInteger(stockId) && stockId > 0) symbolByStockId.set(stockId, String(row.symbol))
  }
  const stockIds = Array.from(symbolByStockId.keys())
  if (!stockIds.length) return out

  const byDate = await readMarks(marketDb, rowDates, stockIds, symbolByStockId)
  // Only rows no benchmark traded on can be closures; resolve their session and read it.
  const candidates = rowDates.filter((date) => !byDate.get(date)?.anyRow)
  const traded = new Set(rowDates.filter((date) => byDate.get(date)?.anyRow))
  const sessions = candidates.length ? await paperValuationSessions(kv, candidates, traded) : new Map<string, string>()
  const moved = [...new Set(candidates.map((date) => sessions.get(date) ?? date).filter((session) => !byDate.has(session)))].sort()
  if (moved.length) for (const [date, entry] of await readMarks(marketDb, moved, stockIds, symbolByStockId)) byDate.set(date, entry)
  for (const date of rowDates) {
    const marks = byDate.get(sessions.get(date) ?? date)?.marks
    if (marks && Object.keys(marks).length) out[date] = { ...marks }
  }
  return out
}
