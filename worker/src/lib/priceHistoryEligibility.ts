// ROSTER-PREP-60: the minimum daily price rows for screener selection. The owner is
// schemas/price-history-eligibility-v1.json (not KV); ml-controller services/price_history_contract.py
// reads the same file for the R33 prep, so the screener never selects a name the prep gives no row.
// The image keeps the source-root depth (Dockerfile COPY to /app/schemas), like evidenceContracts.
import contractJson from '../../../schemas/price-history-eligibility-v1.json'
import { databaseForDataDomain } from './dataDomainRegistry'
import { verifiedCanonicalSessions } from './canonicalSessionIntegrity'
import type { Bindings } from '../types'

export const PRICE_HISTORY_CONTRACT_SCHEMA = 'price-history-eligibility-contract-v1'

export type PriceHistoryEligibilityContract = {
  schema_version: string
  min_price_rows: number
}

/** The validated minimum; an invalid contract throws at load, so the screener fails closed. */
export function validatePriceHistoryContract(raw: unknown): number {
  const contract = raw as Partial<PriceHistoryEligibilityContract> | null
  if (!contract || typeof contract !== 'object' || contract.schema_version !== PRICE_HISTORY_CONTRACT_SCHEMA) {
    throw new Error('price_history_contract_version_invalid')
  }
  const minimum = contract.min_price_rows
  if (typeof minimum !== 'number' || !Number.isInteger(minimum) || minimum < 1) {
    throw new Error('price_history_contract_min_price_rows_invalid')
  }
  return minimum
}

export const MIN_PRICE_ROWS_FOR_SELECTION: number = validatePriceHistoryContract(contractJson)

/** The screener scoring window needs 3 rows; selection needs the contract minimum of rows in the
 *  source the prep counts (loadPrepPriceHistoryCounts). Both counts go to the funnel evidence. */
export const MIN_SCORING_WINDOW_PRICE_ROWS = 3

export function evaluatePriceHistoryGate(windowRows: number, historyRows: number,
  minimum: number = MIN_PRICE_ROWS_FOR_SELECTION) {
  const valid = (n: number) => Number.isInteger(n) && n >= 0
  return {
    // A count that is not a non-negative integer never passes.
    passed: valid(windowRows) && valid(historyRows)
      && windowRows >= MIN_SCORING_WINDOW_PRICE_ROWS && historyRows >= minimum,
    evidence: {
      price_row_count: windowRows,
      minimum_required_price_rows: MIN_SCORING_WINDOW_PRICE_ROWS,
      history_price_row_count: historyRows,
      minimum_required_history_price_rows: minimum,
      history_contract: PRICE_HISTORY_CONTRACT_SCHEMA,
      history_source: PREP_PRICE_HISTORY_SOURCE,
    },
  }
}

/** The rows the R33 prep counts: the controller's training price capture is FinLab's daily price,
 *  mirrored in canonical_market_daily (source finlab.price), and a bar exists where close > 0 on or
 *  before the signal date. stock_prices is not this source: it keeps a former emerging-board symbol's
 *  pre-listing bars (7856: 202 rows there, 41 in the prep on 2026-11-24) and can miss early listed bars
 *  (3718: 47 there, 54 in the prep). */
export const PREP_PRICE_HISTORY_SOURCE = 'market.canonical_market_daily:finlab.price'
const HISTORY_SYMBOL_CHUNK = 90       // + 3 or 4 fixed binds, under D1's 100 bound parameters
const HISTORY_CHUNK_CONCURRENCY = 3
const HISTORY_MAX_ATTEMPTS = 3

async function countChunk(db: D1Database, symbols: string[], runDate: string, fromDate: string | null): Promise<Map<string, number>> {
  const marks = symbols.map(() => '?').join(',')
  // Primary key (stock_id, date, source): one index range per symbol, never a scan.
  const sql = `SELECT stock_id, COUNT(*) AS n FROM canonical_market_daily
    WHERE source = 'finlab.price' AND stock_id IN (${marks})
      AND date <= ?${fromDate ? ' AND date >= ?' : ''} AND close > 0
    GROUP BY stock_id`
  const binds = fromDate ? [...symbols, runDate, fromDate] : [...symbols, runDate]
  const { results } = await retried(() => db.prepare(sql).bind(...binds).all<{ stock_id: string; n: number }>())
  const counts = new Map<string, number>()
  for (const row of results ?? []) counts.set(String(row.stock_id), Number(row.n))
  return counts
}

async function countAll(db: D1Database, symbols: string[], runDate: string, fromDate: string | null): Promise<Map<string, number>> {
  const chunks: string[][] = []
  for (let i = 0; i < symbols.length; i += HISTORY_SYMBOL_CHUNK) chunks.push(symbols.slice(i, i + HISTORY_SYMBOL_CHUNK))
  const counts = new Map<string, number>()
  for (let i = 0; i < chunks.length; i += HISTORY_CHUNK_CONCURRENCY) {
    const parts = await Promise.all(chunks.slice(i, i + HISTORY_CHUNK_CONCURRENCY).map((c) => countChunk(db, c, runDate, fromDate)))
    for (const part of parts) for (const [symbol, n] of part) counts.set(symbol, n)
  }
  return counts
}

async function retried<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= HISTORY_MAX_ATTEMPTS; attempt += 1) {
    try { return await read() } catch (error) {
      lastError = error
      if (attempt < HISTORY_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))))
    }
  }
  throw lastError
}

/** The FinLab session `minimum` sessions back from sessionEnd, from the source's own calendar
 *  (finlab_source_sessions_v1, not stock_prices). null when the calendar is shorter. */
async function recentSessionStart(db: D1Database, sessionEnd: string, minimum: number): Promise<string | null> {
  const { results } = await retried(() => db.prepare(
    `SELECT session_date FROM finlab_source_sessions_v1 WHERE session_date <= ? ORDER BY session_date DESC LIMIT ?`,
  ).bind(sessionEnd, minimum).all<{ session_date: string }>())
  const dates = (results ?? []).map((row) => String(row.session_date))
  return dates.length >= minimum ? dates[dates.length - 1] : null
}

/** symbol -> the prep's row count up to runDate, exact wherever it decides the gate.
 *  sessionEnd is the screener's latest primary session: the prep source must already hold it (a
 *  FinLab session with canonical bars, the canonicalSessionIntegrity rule), otherwise the run throws
 *  screener_price_history_source_stale instead of counting every name one short. The count in the
 *  last `minimum` FinLab sessions is a lower bound, so a name that reaches the minimum there passes
 *  without reading older rows; only the rest are counted in full. A symbol with no row counts 0.
 *  Any failed read throws (the screener run fails closed; the watchdog retries it). */
export async function loadPrepPriceHistoryCounts(env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[], runDate: string, sessionEnd: string,
  minimum: number = MIN_PRICE_ROWS_FOR_SELECTION): Promise<Map<string, number>> {
  const db = databaseForDataDomain(env, 'market')
  try {
    await retried(() => verifiedCanonicalSessions(db, sessionEnd, sessionEnd))
  } catch (error) {
    throw new Error(`screener_price_history_source_stale:session=${sessionEnd}:${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
  }
  const unique = [...new Set(symbols)].sort()
  const counts = new Map<string, number>(unique.map((symbol) => [symbol, 0]))
  try {
    const start = await recentSessionStart(db, sessionEnd, minimum)
    const recent = start ? await countAll(db, unique, runDate, start) : new Map<string, number>()
    for (const [symbol, n] of recent) counts.set(symbol, n)
    const short = unique.filter((symbol) => (counts.get(symbol) ?? 0) < minimum)
    for (const [symbol, n] of await countAll(db, short, runDate, null)) counts.set(symbol, n)
  } catch (error) {
    throw new Error(`screener_price_history_load_failed:run_date=${runDate}:${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
  }
  return counts
}
