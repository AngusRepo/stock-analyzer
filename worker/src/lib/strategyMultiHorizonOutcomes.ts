import type { Bindings } from '../types'
import { databaseForDataDomain, shadowDatabaseForDataDomain } from './dataDomainRegistry'
import {
  STRATEGY_EVIDENCE_HORIZON_DAYS,
  STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
} from './priceHorizonProjection'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'

export const STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION = 'canonical-strategy-selection-outcome-v1'
export const STRATEGY_MULTI_HORIZON_ROUNDTRIP_COST_BPS = 18
const DEFAULT_OUTCOME_LOOKBACK_DAYS = 120
const OUTCOME_ROWS_PER_STATEMENT = 5
const OUTCOME_BATCH_STATEMENTS = 100

type ReferenceRow = {
  signal_date: string
  symbol: string
  producer_run_id: string
  stock_id: number
  market_segment: string | null
  sector: string | null
}

type PriceOutcomeRow = {
  stock_id: number
  price_date: string
  horizon_days: number
  entry_date: string
  entry_raw_open: number | string
  entry_adjustment_factor: number | string
  exit_date: string
  exit_raw_close: number | string
  exit_adjustment_factor: number | string
  outcome_known_date: string
}

type PendingOutcome = {
  reference: ReferenceRow
  horizonDays: number
  entryDate: string
  exitDate: string
  grossReturn: number
  absoluteReturnNet: number
}

type MaterializedOutcome = PendingOutcome & {
  benchmarkReturnNet: number
  benchmarkScope: 'sector' | 'market_segment' | 'market'
  residualReturnNet: number
  crossSectionRank: number
}

export type StrategyMultiHorizonOutcomeResult = {
  asOfDate: string
  referenceRows: number
  horizons: Array<{
    horizonDays: number
    matureRows: number
    pendingRows: number
    unavailableRows: number
    persistedRows: number
  }>
  summary: string
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function dateOnly(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid_${name}:${value}`)
  return value
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function chunks<T>(rows: T[], size: number): T[][] {
  const output: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) {
    output.push(rows.slice(offset, offset + size))
  }
  return output
}

function neutralize(rows: PendingOutcome[]): MaterializedOutcome[] {
  const output: MaterializedOutcome[] = []
  const byDate = new Map<string, PendingOutcome[]>()
  for (const row of rows) byDate.set(row.reference.signal_date, [...(byDate.get(row.reference.signal_date) ?? []), row])
  for (const dateRows of byDate.values()) {
    const marketMean = mean(dateRows.map((row) => row.absoluteReturnNet))
    const sectorRows = new Map<string, PendingOutcome[]>()
    const segmentRows = new Map<string, PendingOutcome[]>()
    for (const row of dateRows) {
      const sector = clean(row.reference.sector)
      const segment = clean(row.reference.market_segment)
      if (sector) sectorRows.set(sector, [...(sectorRows.get(sector) ?? []), row])
      if (segment) segmentRows.set(segment, [...(segmentRows.get(segment) ?? []), row])
    }
    const benchmarkByRow = new Map<PendingOutcome, { value: number; scope: MaterializedOutcome['benchmarkScope'] }>()
    for (const row of dateRows) {
      const sector = sectorRows.get(clean(row.reference.sector)) ?? []
      const segment = segmentRows.get(clean(row.reference.market_segment)) ?? []
      if (sector.length >= 5) benchmarkByRow.set(row, { value: mean(sector.map((item) => item.absoluteReturnNet)), scope: 'sector' })
      else if (segment.length >= 5) benchmarkByRow.set(row, { value: mean(segment.map((item) => item.absoluteReturnNet)), scope: 'market_segment' })
      else benchmarkByRow.set(row, { value: marketMean, scope: 'market' })
    }
    const residuals = dateRows.map((row) => row.absoluteReturnNet - benchmarkByRow.get(row)!.value)
    const sorted = [...residuals].sort((left, right) => left - right)
    for (let index = 0; index < dateRows.length; index += 1) {
      const row = dateRows[index]
      const benchmark = benchmarkByRow.get(row)!
      const residual = residuals[index]
      const lower = sorted.findIndex((value) => value >= residual)
      const upper = sorted.length - 1 - [...sorted].reverse().findIndex((value) => value <= residual)
      const rankIndex = (lower + upper) / 2
      output.push({
        ...row,
        benchmarkReturnNet: benchmark.value,
        benchmarkScope: benchmark.scope,
        residualReturnNet: residual,
        crossSectionRank: sorted.length === 1 ? 0.5 : rankIndex / (sorted.length - 1),
      })
    }
  }
  return output
}

async function canonicalRunIds(
  opsDb: D1Database,
  startDate: string | undefined,
  endDate: string,
): Promise<Set<string>> {
  const clauses = ["logical_run_key LIKE 'screener:%:TW:production:market_screener'"]
  const binds: unknown[] = []
  if (startDate) { clauses.push("substr(logical_run_key,10,10) >= ?"); binds.push(startDate) }
  clauses.push("substr(logical_run_key,10,10) <= ?")
  binds.push(endDate)
  const result = await opsDb.prepare(`
    SELECT run_id FROM canonical_run_heads WHERE ${clauses.join(' AND ')}
  `).bind(...binds).all<{ run_id: string }>()
  return new Set((result.results ?? []).map((row) => row.run_id))
}

async function listReferences(
  learningDb: D1Database,
  canonicalIds: Set<string>,
  startDate: string | undefined,
  endDate: string,
): Promise<ReferenceRow[]> {
  const output: ReferenceRow[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  for (;;) {
    const clauses = [
      'signal_date <= ?',
      'hard_gate_passed=1',
      'feature_contract_version=?',
      '(signal_date > ? OR (signal_date = ? AND symbol > ?))',
    ]
    const binds: unknown[] = [endDate, SELECTION_REFERENCE_CONTRACT_VERSION, cursorDate, cursorDate, cursorSymbol]
    if (startDate) { clauses.push('signal_date >= ?'); binds.push(startDate) }
    const page = await learningDb.prepare(`
      SELECT signal_date, symbol, producer_run_id, stock_id, market_segment, sector
        FROM selection_reference_snapshots_v1
       WHERE ${clauses.join(' AND ')}
       ORDER BY signal_date, symbol
       LIMIT 500
    `).bind(...binds).all<ReferenceRow>()
    const rows = page.results ?? []
    output.push(...rows.filter((row) => canonicalIds.has(row.producer_run_id)))
    if (rows.length < 500) break
    cursorDate = rows.at(-1)!.signal_date
    cursorSymbol = rows.at(-1)!.symbol
  }
  return output
}

async function loadPriceOutcomes(
  learningDb: D1Database,
  references: ReferenceRow[],
  horizonDays: number,
): Promise<Map<string, PriceOutcomeRow>> {
  const output = new Map<string, PriceOutcomeRow>()
  if (!references.length) return output
  const stockIds = [...new Set(references.map((row) => Number(row.stock_id)).filter((value) => Number.isInteger(value) && value > 0))]
  const dates = references.map((row) => row.signal_date).sort()
  for (let offset = 0; offset < stockIds.length; offset += 80) {
    const ids = stockIds.slice(offset, offset + 80)
    const result = await learningDb.prepare(`
      SELECT stock_id, price_date, horizon_days, entry_date, entry_raw_open,
             entry_adjustment_factor, exit_date, exit_raw_close,
             exit_adjustment_factor, outcome_known_date
        FROM price_horizon_labels_v2
       WHERE horizon_days=? AND stock_id IN (${ids.map(() => '?').join(',')})
         AND price_date >= ? AND price_date <= ? AND projection_version=?
    `).bind(
      horizonDays, ...ids, dates[0], dates.at(-1), STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
    ).all<PriceOutcomeRow>()
    for (const row of result.results ?? []) output.set(`${row.stock_id}|${row.price_date}`, row)
  }
  return output
}

async function persistOutcomes(
  learningDb: D1Database,
  rows: MaterializedOutcome[],
  costBps: number,
): Promise<number> {
  if (!rows.length) return 0
  // D1 accepts at most 100 bound parameters per prepared statement. Five
  // outcome rows use 95 bindings and reduce the fixed 120-day refresh from one
  // statement per row to one statement per five rows without changing identity.
  const statements = chunks(rows, OUTCOME_ROWS_PER_STATEMENT).map((group) => {
    const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = group.flatMap((row) => [
      row.reference.signal_date, row.reference.symbol, row.reference.producer_run_id,
      row.horizonDays, STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION,
      row.reference.market_segment, row.reference.sector, row.entryDate, row.exitDate,
      row.exitDate, row.grossReturn, costBps, row.absoluteReturnNet,
      row.benchmarkReturnNet, row.benchmarkScope, row.residualReturnNet,
      row.crossSectionRank, 'price_horizon_labels_v2:finlab_primary_canonical_mirror',
      SELECTION_REFERENCE_CONTRACT_VERSION,
    ])
    return learningDb.prepare(`
      INSERT INTO canonical_selection_outcomes_v1 (
        signal_date, symbol, producer_run_id, horizon_days, label_schema_version,
        market_segment, sector, entry_date, exit_date, outcome_known_date,
        gross_return, transaction_cost_bps, absolute_return_net,
        benchmark_return_net, benchmark_scope, residual_return_net, cross_section_rank,
        adjustment_source, reference_contract_version
      ) VALUES ${values}
      ON CONFLICT(signal_date, symbol, producer_run_id, horizon_days, label_schema_version) DO UPDATE SET
        market_segment=excluded.market_segment, sector=excluded.sector,
        entry_date=excluded.entry_date, exit_date=excluded.exit_date,
        outcome_known_date=excluded.outcome_known_date, gross_return=excluded.gross_return,
        transaction_cost_bps=excluded.transaction_cost_bps,
        absolute_return_net=excluded.absolute_return_net,
        benchmark_return_net=excluded.benchmark_return_net,
        benchmark_scope=excluded.benchmark_scope,
        residual_return_net=excluded.residual_return_net,
        cross_section_rank=excluded.cross_section_rank,
        adjustment_source=excluded.adjustment_source,
        reference_contract_version=excluded.reference_contract_version,
        created_at=CURRENT_TIMESTAMP
    `).bind(...params)
  })
  for (let offset = 0; offset < statements.length; offset += OUTCOME_BATCH_STATEMENTS) {
    await learningDb.batch(statements.slice(offset, offset + OUTCOME_BATCH_STATEMENTS))
  }
  return rows.length
}

export async function materializeStrategyMultiHorizonOutcomes(
  env: Bindings,
  options: { asOfDate: string; startDate?: string; endDate?: string; transactionCostBps?: number },
): Promise<StrategyMultiHorizonOutcomeResult> {
  const sourceLearningDb = databaseForDataDomain(env, 'learning')
  const targetLearningDb = shadowDatabaseForDataDomain(env, 'learning') ?? sourceLearningDb
  const opsDb = databaseForDataDomain(env, 'ops')
  const asOfDate = dateOnly(options.asOfDate, 'strategy_outcome_as_of_date')
  const endDate = dateOnly(options.endDate ?? asOfDate, 'strategy_outcome_end_date')
  const startDate = dateOnly(
    options.startDate ?? shiftDate(endDate, -DEFAULT_OUTCOME_LOOKBACK_DAYS),
    'strategy_outcome_start_date',
  )
  if (startDate > endDate || endDate > asOfDate) throw new Error('invalid_strategy_outcome_date_range')
  const costBps = Number.isFinite(options.transactionCostBps)
    ? Math.max(0, Number(options.transactionCostBps))
    : STRATEGY_MULTI_HORIZON_ROUNDTRIP_COST_BPS
  const heads = await canonicalRunIds(opsDb, startDate, endDate)
  const references = await listReferences(sourceLearningDb, heads, startDate, endDate)
  const results: StrategyMultiHorizonOutcomeResult['horizons'] = []
  for (const horizonDays of STRATEGY_EVIDENCE_HORIZON_DAYS) {
    const priceOutcomes = await loadPriceOutcomes(targetLearningDb, references, horizonDays)
    const pending: PendingOutcome[] = []
    let pendingRows = 0
    let unavailableRows = 0
    for (const reference of references) {
      const price = priceOutcomes.get(`${reference.stock_id}|${reference.signal_date}`)
      if (!price) { unavailableRows += 1; continue }
      if (price.outcome_known_date > asOfDate) { pendingRows += 1; continue }
      const entryOpen = finite(price.entry_raw_open)
      const entryFactor = finite(price.entry_adjustment_factor)
      const exitClose = finite(price.exit_raw_close)
      const exitFactor = finite(price.exit_adjustment_factor)
      if (!entryOpen || !entryFactor || !exitClose || !exitFactor) { unavailableRows += 1; continue }
      const grossReturn = (exitClose * exitFactor) / (entryOpen * entryFactor) - 1
      pending.push({ reference, horizonDays, entryDate: price.entry_date, exitDate: price.exit_date,
        grossReturn, absoluteReturnNet: grossReturn - costBps / 10_000 })
    }
    const outcomes = neutralize(pending)
    const persistedRows = await persistOutcomes(targetLearningDb, outcomes, costBps)
    results.push({ horizonDays, matureRows: outcomes.length, pendingRows, unavailableRows, persistedRows })
  }
  const summary = results.map((row) => `${row.horizonDays}d=${row.persistedRows}/${row.matureRows},pending=${row.pendingRows},unavailable=${row.unavailableRows}`).join(' ')
  return { asOfDate, referenceRows: references.length, horizons: results,
    summary: `strategy_multi_horizon_outcomes window=${startDate}..${endDate} references=${references.length} ${summary}` }
}
