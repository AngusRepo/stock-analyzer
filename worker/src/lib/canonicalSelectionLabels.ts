import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'

export const CANONICAL_SELECTION_LABEL_SCHEMA_VERSION = 'canonical-strategy-selection-label-v4'
export const CANONICAL_SELECTION_ROUNDTRIP_COST_BPS = 18

interface ReferenceRow {
  signal_date: string
  symbol: string
  producer_run_id: string
  market_segment: string | null
  sector: string | null
}

interface PriceRow {
  symbol: string
  date: string
  open: number | string | null
  close: number | string | null
  adj_close: number | string | null
}

interface PendingLabel {
  reference: ReferenceRow
  entryDate: string
  exitDate: string
  entryRawOpen: number
  exitRawClose: number
  entryFactor: number
  exitFactor: number
  grossReturn: number
  absoluteReturnNet: number
}

interface MaterializedLabel extends PendingLabel {
  benchmarkReturnNet: number
  benchmarkScope: 'sector' | 'market_segment' | 'market'
  residualReturnNet: number
  crossSectionRank: number
}

export interface CanonicalSelectionLabelMaterializationResult {
  run_id: string
  as_of_date: string
  reference_rows: number
  mature_rows: number
  pending_rows: number
  unavailable_rows: number
  persisted_rows: number
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

function rankByDate(rows: PendingLabel[], benchmarks: Map<PendingLabel, { value: number; scope: MaterializedLabel['benchmarkScope'] }>): MaterializedLabel[] {
  const byDate = new Map<string, PendingLabel[]>()
  for (const row of rows) {
    const bucket = byDate.get(row.reference.signal_date) ?? []
    bucket.push(row)
    byDate.set(row.reference.signal_date, bucket)
  }
  const output: MaterializedLabel[] = []
  for (const dateRows of byDate.values()) {
    const residuals = dateRows.map((row) => row.absoluteReturnNet - (benchmarks.get(row)?.value ?? 0))
    const sorted = [...residuals].sort((left, right) => left - right)
    for (let index = 0; index < dateRows.length; index++) {
      const row = dateRows[index]
      const benchmark = benchmarks.get(row)!
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

function neutralize(rows: PendingLabel[]): MaterializedLabel[] {
  const benchmarks = new Map<PendingLabel, { value: number; scope: MaterializedLabel['benchmarkScope'] }>()
  const byDate = new Map<string, PendingLabel[]>()
  for (const row of rows) {
    const bucket = byDate.get(row.reference.signal_date) ?? []
    bucket.push(row)
    byDate.set(row.reference.signal_date, bucket)
  }
  for (const dateRows of byDate.values()) {
    const marketMean = mean(dateRows.map((row) => row.absoluteReturnNet))
    const sector = new Map<string, PendingLabel[]>()
    const segment = new Map<string, PendingLabel[]>()
    for (const row of dateRows) {
      const sectorKey = clean(row.reference.sector)
      const segmentKey = clean(row.reference.market_segment)
      if (sectorKey) sector.set(sectorKey, [...(sector.get(sectorKey) ?? []), row])
      if (segmentKey) segment.set(segmentKey, [...(segment.get(segmentKey) ?? []), row])
    }
    for (const row of dateRows) {
      const sectorRows = sector.get(clean(row.reference.sector)) ?? []
      const segmentRows = segment.get(clean(row.reference.market_segment)) ?? []
      if (sectorRows.length >= 5) {
        benchmarks.set(row, { value: mean(sectorRows.map((item) => item.absoluteReturnNet)), scope: 'sector' })
      } else if (segmentRows.length >= 5) {
        benchmarks.set(row, { value: mean(segmentRows.map((item) => item.absoluteReturnNet)), scope: 'market_segment' })
      } else {
        benchmarks.set(row, { value: marketMean, scope: 'market' })
      }
    }
  }
  return rankByDate(rows, benchmarks)
}

async function listCanonicalReferences(
  db: D1Database,
  asOfDate: string,
  startDate?: string,
  endDate?: string,
): Promise<ReferenceRow[]> {
  const rows: ReferenceRow[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  for (;;) {
    const clauses = [
      "r.signal_date <= ?",
      "r.feature_contract_version = ?",
      "(r.signal_date > ? OR (r.signal_date = ? AND r.symbol > ?))",
      "EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.logical_run_key = 'screener:' || r.signal_date || ':TW:production:market_screener' AND h.run_id = r.producer_run_id)",
      "NOT EXISTS (SELECT 1 FROM canonical_selection_labels_v4 l WHERE l.signal_date = r.signal_date AND l.symbol = r.symbol AND l.producer_run_id = r.producer_run_id AND l.label_schema_version = 'canonical-strategy-selection-label-v4' AND l.reference_contract_version = ?)",
    ]
    const binds: unknown[] = [
      asOfDate,
      SELECTION_REFERENCE_CONTRACT_VERSION,
      cursorDate,
      cursorDate,
      cursorSymbol,
      SELECTION_REFERENCE_CONTRACT_VERSION,
    ]
    if (startDate) { clauses.push('r.signal_date >= ?'); binds.push(startDate) }
    if (endDate) { clauses.push('r.signal_date <= ?'); binds.push(endDate) }
    const page = await db.prepare(`
      SELECT r.signal_date, r.symbol, r.producer_run_id, r.market_segment, r.sector
        FROM selection_reference_snapshots_v1 r
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.signal_date, r.symbol
       LIMIT 500
    `).bind(...binds).all<ReferenceRow>()
    const pageRows = page.results ?? []
    rows.push(...pageRows)
    if (pageRows.length < 500) break
    cursorDate = pageRows.at(-1)!.signal_date
    cursorSymbol = pageRows.at(-1)!.symbol
  }
  return rows
}

async function loadCanonicalPrices(db: D1Database, references: ReferenceRow[], asOfDate: string): Promise<Map<string, PriceRow[]>> {
  const output = new Map<string, PriceRow[]>()
  const symbols = [...new Set(references.map((row) => row.symbol))]
  const minDate = references.map((row) => row.signal_date).sort()[0]
  for (let offset = 0; offset < symbols.length; offset += 80) {
    const chunk = symbols.slice(offset, offset + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const result = await db.prepare(`
      SELECT stock_id symbol, date, open, close, adj_close
        FROM canonical_market_daily
       WHERE stock_id IN (${placeholders})
         AND source = 'finlab.price'
         AND date > ? AND date <= ?
       ORDER BY stock_id, date
    `).bind(...chunk, minDate, asOfDate).all<PriceRow>()
    for (const row of result.results ?? []) {
      const bucket = output.get(row.symbol) ?? []
      bucket.push(row)
      output.set(row.symbol, bucket)
    }
  }
  return output
}

export async function materializeCanonicalSelectionLabelsV4(
  db: D1Database,
  options: { asOfDate: string; startDate?: string; endDate?: string; transactionCostBps?: number },
): Promise<CanonicalSelectionLabelMaterializationResult> {
  const costBps = Number.isFinite(options.transactionCostBps)
    ? Math.max(0, Number(options.transactionCostBps))
    : CANONICAL_SELECTION_ROUNDTRIP_COST_BPS
  const runId = `selection-label-v4-${options.asOfDate}-${options.startDate ?? 'all'}-${options.endDate ?? 'all'}`
  const references = await listCanonicalReferences(db, options.asOfDate, options.startDate, options.endDate)
  const prices = references.length ? await loadCanonicalPrices(db, references, options.asOfDate) : new Map<string, PriceRow[]>()
  const mature: PendingLabel[] = []
  const rejections: Array<{ reference: ReferenceRow; reason: string }> = []
  let pending = 0

  for (const reference of references) {
    const future = (prices.get(reference.symbol) ?? []).filter((row) => row.date > reference.signal_date)
    if (future.length < 5) { pending++; continue }
    const entry = future[0]
    const exit = future[4]
    const entryOpen = finite(entry.open)
    const entryClose = finite(entry.close)
    const entryAdjClose = finite(entry.adj_close)
    const exitClose = finite(exit.close)
    const exitAdjClose = finite(exit.adj_close)
    if (entryOpen == null || entryOpen <= 0 || entryClose == null || entryClose <= 0 || entryAdjClose == null || entryAdjClose <= 0) {
      rejections.push({ reference, reason: 'entry_raw_or_adjustment_factor_missing' })
      continue
    }
    if (exitClose == null || exitClose <= 0 || exitAdjClose == null || exitAdjClose <= 0) {
      rejections.push({ reference, reason: 'exit_raw_or_adjustment_factor_missing' })
      continue
    }
    const entryFactor = entryAdjClose / entryClose
    const exitFactor = exitAdjClose / exitClose
    const grossReturn = (exitClose * exitFactor) / (entryOpen * entryFactor) - 1
    mature.push({
      reference,
      entryDate: entry.date,
      exitDate: exit.date,
      entryRawOpen: entryOpen,
      exitRawClose: exitClose,
      entryFactor,
      exitFactor,
      grossReturn,
      absoluteReturnNet: grossReturn - costBps / 10_000,
    })
  }

  const labels = neutralize(mature)
  const labelStatements = labels.map((row) => db.prepare(`
    INSERT INTO canonical_selection_labels_v4 (
      signal_date, symbol, label_schema_version, producer_run_id,
      market_segment, sector, entry_date, exit_date, outcome_known_date,
      entry_raw_open, exit_raw_close, entry_adjustment_factor, exit_adjustment_factor,
      gross_return, transaction_cost_bps, absolute_return_net,
      benchmark_return_net, benchmark_scope, residual_return_net, cross_section_rank,
      adjustment_source, reference_contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'canonical_market_daily:finlab.price', ?)
    ON CONFLICT(signal_date, symbol, producer_run_id, label_schema_version) DO NOTHING
  `).bind(
    row.reference.signal_date, row.reference.symbol, CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
    row.reference.producer_run_id, row.reference.market_segment, row.reference.sector,
    row.entryDate, row.exitDate, row.exitDate, row.entryRawOpen, row.exitRawClose,
    row.entryFactor, row.exitFactor, row.grossReturn, costBps, row.absoluteReturnNet,
    row.benchmarkReturnNet, row.benchmarkScope, row.residualReturnNet, row.crossSectionRank,
    SELECTION_REFERENCE_CONTRACT_VERSION,
  ))
  for (let offset = 0; offset < labelStatements.length; offset += 200) {
    await db.batch(labelStatements.slice(offset, offset + 200))
  }
  const rejectionStatements = rejections.map(({ reference, reason }) => db.prepare(`
    INSERT OR IGNORE INTO canonical_selection_label_rejections_v4 (
      signal_date, symbol, producer_run_id, reason_code, as_of_date
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(reference.signal_date, reference.symbol, reference.producer_run_id, reason, options.asOfDate))
  for (let offset = 0; offset < rejectionStatements.length; offset += 200) {
    await db.batch(rejectionStatements.slice(offset, offset + 200))
  }

  await db.prepare(`
    INSERT INTO canonical_selection_label_runs_v4 (
      run_id, as_of_date, status, reference_rows, mature_rows, pending_rows, unavailable_rows, error_code
    ) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL)
    ON CONFLICT(run_id) DO UPDATE SET
      status='ready', reference_rows=excluded.reference_rows, mature_rows=excluded.mature_rows,
      pending_rows=excluded.pending_rows, unavailable_rows=excluded.unavailable_rows, error_code=NULL
  `).bind(runId, options.asOfDate, references.length, labels.length, pending, rejections.length).run()
  return {
    run_id: runId,
    as_of_date: options.asOfDate,
    reference_rows: references.length,
    mature_rows: labels.length,
    pending_rows: pending,
    unavailable_rows: rejections.length,
    persisted_rows: labels.length,
  }
}
