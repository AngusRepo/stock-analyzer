import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import { PRICE_HORIZON_PROJECTION_VERSION } from './priceHorizonProjection'

export const CANONICAL_SELECTION_LABEL_SCHEMA_VERSION = 'canonical-strategy-selection-label-v4'
export const CANONICAL_SELECTION_ROUNDTRIP_COST_BPS = 18

interface ReferenceRow {
  signal_date: string
  symbol: string
  producer_run_id: string
  stock_id: number
  market_segment: string | null
  sector: string | null
}

interface PriceHorizonEvidenceRow {
  stock_id: number
  price_date: string
  entry_date: string
  entry_raw_open: number | string
  entry_adjustment_factor: number | string
  exit_date: string
  exit_raw_close: number | string
  exit_adjustment_factor: number | string
  outcome_known_date: string
}

interface PriceHorizonRejectionRow {
  stock_id: number
  price_date: string
  entry_date: string
  exit_date: string
  rejection_reason: string
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
      SELECT r.signal_date, r.symbol, r.producer_run_id, r.stock_id, r.market_segment, r.sector
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

async function loadPriceHorizonEvidence(
  db: D1Database,
  references: ReferenceRow[],
): Promise<{
  labels: Map<string, PriceHorizonEvidenceRow>
  rejections: Map<string, PriceHorizonRejectionRow>
}> {
  const labels = new Map<string, PriceHorizonEvidenceRow>()
  const rejections = new Map<string, PriceHorizonRejectionRow>()
  const stockIds = [...new Set(references.map((row) => Number(row.stock_id)).filter((id) => Number.isInteger(id) && id > 0))]
  const signalDates = references.map((row) => row.signal_date).sort()
  const minDate = signalDates[0]
  const maxDate = signalDates[signalDates.length - 1]
  for (let offset = 0; offset < stockIds.length; offset += 80) {
    const chunk = stockIds.slice(offset, offset + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const [labelResult, rejectionResult] = await Promise.all([
      db.prepare(`
        SELECT stock_id, price_date, entry_date, entry_raw_open, entry_adjustment_factor,
               exit_date, exit_raw_close, exit_adjustment_factor, outcome_known_date
          FROM price_horizon_labels_v1
         WHERE stock_id IN (${placeholders})
           AND price_date >= ? AND price_date <= ?
           AND projection_version=?
      `).bind(...chunk, minDate, maxDate, PRICE_HORIZON_PROJECTION_VERSION).all<PriceHorizonEvidenceRow>(),
      db.prepare(`
        SELECT stock_id, price_date, entry_date, exit_date, rejection_reason
          FROM price_horizon_label_rejections_v1
         WHERE stock_id IN (${placeholders})
           AND price_date >= ? AND price_date <= ?
           AND projection_version=?
      `).bind(...chunk, minDate, maxDate, PRICE_HORIZON_PROJECTION_VERSION).all<PriceHorizonRejectionRow>(),
    ])
    for (const row of labelResult.results ?? []) {
      labels.set(`${row.stock_id}|${row.price_date}`, row)
    }
    for (const row of rejectionResult.results ?? []) {
      rejections.set(`${row.stock_id}|${row.price_date}`, row)
    }
  }
  return { labels, rejections }
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
  const horizonEvidence = references.length
    ? await loadPriceHorizonEvidence(db, references)
    : { labels: new Map<string, PriceHorizonEvidenceRow>(), rejections: new Map<string, PriceHorizonRejectionRow>() }
  const mature: PendingLabel[] = []
  const rejections: Array<{ reference: ReferenceRow; reason: string }> = []
  let pending = 0

  for (const reference of references) {
    const key = `${reference.stock_id}|${reference.signal_date}`
    const horizon = horizonEvidence.labels.get(key)
    const rejection = horizonEvidence.rejections.get(key)
    if (!horizon) {
      if (rejection && rejection.exit_date <= options.asOfDate) {
        rejections.push({ reference, reason: `price_horizon_${clean(rejection.rejection_reason) || 'unavailable'}` })
      } else {
        pending++
      }
      continue
    }
    if (horizon.outcome_known_date > options.asOfDate) { pending++; continue }
    const entryOpen = finite(horizon.entry_raw_open)
    const entryFactor = finite(horizon.entry_adjustment_factor)
    const exitClose = finite(horizon.exit_raw_close)
    const exitFactor = finite(horizon.exit_adjustment_factor)
    if (
      entryOpen == null || entryOpen <= 0 || entryFactor == null || entryFactor <= 0
      || exitClose == null || exitClose <= 0 || exitFactor == null || exitFactor <= 0
    ) {
      rejections.push({ reference, reason: 'price_horizon_materialized_values_invalid' })
      continue
    }
    const grossReturn = (exitClose * exitFactor) / (entryOpen * entryFactor) - 1
    mature.push({
      reference,
      entryDate: horizon.entry_date,
      exitDate: horizon.exit_date,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'price_horizon_labels_v1:finlab_primary_canonical_mirror', ?)
    ON CONFLICT(signal_date, symbol, producer_run_id, label_schema_version) DO UPDATE SET
      market_segment=excluded.market_segment,
      sector=excluded.sector,
      entry_date=excluded.entry_date,
      exit_date=excluded.exit_date,
      outcome_known_date=excluded.outcome_known_date,
      entry_raw_open=excluded.entry_raw_open,
      exit_raw_close=excluded.exit_raw_close,
      entry_adjustment_factor=excluded.entry_adjustment_factor,
      exit_adjustment_factor=excluded.exit_adjustment_factor,
      gross_return=excluded.gross_return,
      transaction_cost_bps=excluded.transaction_cost_bps,
      absolute_return_net=excluded.absolute_return_net,
      benchmark_return_net=excluded.benchmark_return_net,
      benchmark_scope=excluded.benchmark_scope,
      residual_return_net=excluded.residual_return_net,
      cross_section_rank=excluded.cross_section_rank,
      adjustment_source=excluded.adjustment_source,
      reference_contract_version=excluded.reference_contract_version
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
  const resolvedRejectionDeletes = labels.map((row) => db.prepare(`
    DELETE FROM canonical_selection_label_rejections_v4
     WHERE signal_date=? AND symbol=? AND producer_run_id=?
  `).bind(row.reference.signal_date, row.reference.symbol, row.reference.producer_run_id))
  for (let offset = 0; offset < resolvedRejectionDeletes.length; offset += 200) {
    await db.batch(resolvedRejectionDeletes.slice(offset, offset + 200))
  }
  const rejectionDeletes = rejections.map(({ reference }) => db.prepare(`
    DELETE FROM canonical_selection_label_rejections_v4
     WHERE signal_date=? AND symbol=? AND producer_run_id=?
  `).bind(reference.signal_date, reference.symbol, reference.producer_run_id))
  for (let offset = 0; offset < rejectionDeletes.length; offset += 200) {
    await db.batch(rejectionDeletes.slice(offset, offset + 200))
  }
  const rejectionStatements = rejections.map(({ reference, reason }) => db.prepare(`
    INSERT INTO canonical_selection_label_rejections_v4 (
      signal_date, symbol, producer_run_id, reason_code, as_of_date
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(signal_date, symbol, producer_run_id, reason_code) DO UPDATE SET
      as_of_date=excluded.as_of_date
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
