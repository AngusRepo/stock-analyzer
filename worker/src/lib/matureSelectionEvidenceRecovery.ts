import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  CANONICAL_SELECTION_ADJUSTMENT_SOURCE,
  CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
  materializeCanonicalSelectionLabelsV4,
} from './canonicalSelectionLabels'
import {
  PRICE_HORIZON_PROJECTION_VERSION,
  materializePriceHorizonLabels,
} from './priceHorizonProjection'
import {
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
} from './selectionReferenceEvidence'
import {
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

const DEFAULT_LOOKBACK_DAYS = 180
const DEFAULT_MAX_RECOVERY_DATES = 4
const HEAD_PAGE_SIZE = 24

type CanonicalHeadRow = {
  signal_date: string
  run_id: string
}

type CoverageRow = {
  signal_date: string
  producer_run_id: string
  reference_rows: number | string
  matrix_rows: number | string
  expected_matrix_rows: number | string
  persisted_matrix_rows: number | string
  identity_rows: number | string
  horizon_rows: number | string
  horizon_unavailable_rows: number | string
  label_rows: number | string
  label_unavailable_rows: number | string
}

export type MatureSelectionEvidenceGap = {
  signalDate: string
  producerRunId: string
  referenceRows: number
  identityRows: number
  matrixRows: number
  expectedMatrixRows: number
  persistedMatrixRows: number
  horizonRows: number
  horizonUnavailableRows: number
  labelRows: number
  labelUnavailableRows: number
  blockers: string[]
}

export type MatureSelectionEvidenceRecoveryResult = {
  businessDate: string
  blockedDates: Array<{ signalDate: string; blockers: string[] }>
  matureSignalDate: string | null
  inspectedDates: number
  gapDatesBefore: string[]
  recoveredDates: string[]
  gapDatesAfter: string[]
  projectionRuns: number
  labelRowsPersisted: number
  summary: string
}

function dateOnly(value: unknown, field: string): string {
  const date = String(value ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid_${field}:${value}`)
  return date
}

function shiftDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`)
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10)
}

function positiveInt(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

function chunks<T>(rows: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size))
  return output
}

export async function resolveExpectedMatureSignalDate(
  env: Bindings,
  businessDateInput: string,
): Promise<string | null> {
  const businessDate = dateOnly(businessDateInput, 'mature_selection_business_date')
  const marketDb = databaseForDataDomain(env, 'market')
  const row = await marketDb.prepare(`
    SELECT session_date
      FROM market_trading_sessions
     WHERE session_date < ?
     ORDER BY session_date DESC
     LIMIT 1 OFFSET 4
  `).bind(businessDate).first<{ session_date: string | null }>()
  const maturityBoundary = String(row?.session_date ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(maturityBoundary)) return null
  const canonical = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT substr(logical_run_key, 10, 10) AS signal_date
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) <= ?
     ORDER BY signal_date DESC
     LIMIT 1
  `).bind(maturityBoundary).first<{ signal_date: string | null }>()
  const canonicalDate = String(canonical?.signal_date ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(canonicalDate) ? canonicalDate : null
}

async function loadCanonicalHeads(
  env: Bindings,
  startDate: string,
  endDate: string,
): Promise<CanonicalHeadRow[]> {
  const result = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT substr(logical_run_key, 10, 10) signal_date, run_id
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) BETWEEN ? AND ?
     ORDER BY signal_date
  `).bind(startDate, endDate).all<CanonicalHeadRow>()
  return (result.results ?? []).filter((row) => (
    /^\d{4}-\d{2}-\d{2}$/.test(String(row.signal_date ?? ''))
    && String(row.run_id ?? '').trim().length > 0
  ))
}

async function loadCoverageRows(
  db: D1Database,
  heads: CanonicalHeadRow[],
): Promise<CoverageRow[]> {
  const output: CoverageRow[] = []
  for (const page of chunks(heads, HEAD_PAGE_SIZE)) {
    const targetRows = page.map(() => '(?, ?)').join(', ')
    const binds = page.flatMap((row) => [row.signal_date, row.run_id])
    const result = await db.prepare(`
      WITH target_heads(signal_date, producer_run_id) AS (
        VALUES ${targetRows}
      ),
      formal_runs AS (
        SELECT mr.producer_run_id, mr.signal_date, mr.expected_cell_count,
               mr.persisted_cell_count, mr.labeler_version, mr.reference_contract_version
          FROM strategy_label_matrix_runs_v4 mr
          JOIN target_heads t
            ON t.signal_date=mr.signal_date
           AND t.producer_run_id=mr.producer_run_id
         WHERE mr.status='ready' AND (
           (mr.reference_contract_version=? AND mr.labeler_version IN (?, ?))
           OR
           (mr.reference_contract_version=? AND mr.labeler_version IN (?, ?))
         )
      ),
      horizon AS (
        SELECT DISTINCT p.price_date, p.stock_id
          FROM price_horizon_labels_v1 p
          JOIN target_heads t ON t.signal_date=p.price_date
         WHERE p.projection_version=?
      ),
      horizon_rejections AS (
        SELECT DISTINCT p.price_date, p.stock_id
          FROM price_horizon_label_rejections_v1 p
          JOIN target_heads t ON t.signal_date=p.price_date
         WHERE p.projection_version=?
      ),
      labels AS (
        SELECT DISTINCT l.signal_date, l.symbol, l.producer_run_id, l.reference_contract_version
          FROM canonical_selection_labels_v4 l
          JOIN target_heads t
            ON t.signal_date=l.signal_date
           AND t.producer_run_id=l.producer_run_id
         WHERE l.label_schema_version=? AND l.adjustment_source=?
      ),
      label_rejections AS (
        SELECT DISTINCT x.signal_date, x.symbol, x.producer_run_id
          FROM canonical_selection_label_rejections_v4 x
          JOIN target_heads t
            ON t.signal_date=x.signal_date
           AND t.producer_run_id=x.producer_run_id
      ),
      matrix_counts AS (
        SELECT m.signal_date, m.producer_run_id, m.labeler_version,
               m.reference_contract_version, COUNT(*) matrix_rows
          FROM strategy_label_matrix_v4 m
          JOIN target_heads t
            ON t.signal_date=m.signal_date
           AND t.producer_run_id=m.producer_run_id
         GROUP BY m.signal_date, m.producer_run_id, m.labeler_version, m.reference_contract_version
      )
      SELECT r.signal_date, r.producer_run_id,
             COUNT(*) reference_rows,
             SUM(CASE WHEN r.stock_id IS NOT NULL THEN 1 ELSE 0 END) identity_rows,
             SUM(CASE WHEN h.stock_id IS NOT NULL THEN 1 ELSE 0 END) horizon_rows,
             SUM(CASE WHEN hr.stock_id IS NOT NULL THEN 1 ELSE 0 END) horizon_unavailable_rows,
             SUM(CASE WHEN l.symbol IS NOT NULL THEN 1 ELSE 0 END) label_rows,
             COALESCE(MAX(mc.matrix_rows), 0) matrix_rows,
             COALESCE(MAX(mr.expected_cell_count), 0) expected_matrix_rows,
             COALESCE(MAX(mr.persisted_cell_count), 0) persisted_matrix_rows,
             SUM(CASE WHEN x.symbol IS NOT NULL THEN 1 ELSE 0 END) label_unavailable_rows
        FROM selection_reference_snapshots_v1 r
        JOIN target_heads t
          ON t.signal_date=r.signal_date
         AND t.producer_run_id=r.producer_run_id
        JOIN formal_runs mr
          ON mr.signal_date=r.signal_date
         AND mr.producer_run_id=r.producer_run_id
         AND mr.labeler_version=r.strategy_labeler_version
        LEFT JOIN horizon h
          ON h.price_date=r.signal_date AND h.stock_id=r.stock_id
        LEFT JOIN horizon_rejections hr
          ON hr.price_date=r.signal_date AND hr.stock_id=r.stock_id
        LEFT JOIN labels l
          ON l.signal_date=r.signal_date AND l.symbol=r.symbol
         AND l.producer_run_id=r.producer_run_id
         AND l.reference_contract_version=mr.reference_contract_version
        LEFT JOIN label_rejections x
          ON x.signal_date=r.signal_date AND x.symbol=r.symbol
         AND x.producer_run_id=r.producer_run_id
        LEFT JOIN matrix_counts mc
          ON mc.signal_date=r.signal_date
         AND mc.producer_run_id=r.producer_run_id
         AND mc.labeler_version=mr.labeler_version
         AND mc.reference_contract_version=mr.reference_contract_version
       WHERE r.hard_gate_passed=1
         AND r.feature_contract_version=mr.reference_contract_version
       GROUP BY r.signal_date, r.producer_run_id
       ORDER BY r.signal_date
    `).bind(
      ...binds,
      SELECTION_REFERENCE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
      SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
      PRICE_HORIZON_PROJECTION_VERSION,
      PRICE_HORIZON_PROJECTION_VERSION,
      CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
      CANONICAL_SELECTION_ADJUSTMENT_SOURCE,
    ).all<CoverageRow>()
    output.push(...(result.results ?? []))
  }
  return output
}

function toGap(row: CoverageRow): MatureSelectionEvidenceGap | null {
  const referenceRows = positiveInt(row.reference_rows)
  const identityRows = positiveInt(row.identity_rows)
  const horizonRows = positiveInt(row.horizon_rows)
  const horizonUnavailableRows = positiveInt(row.horizon_unavailable_rows)
  const labelRows = positiveInt(row.label_rows)
  const labelUnavailableRows = positiveInt(row.label_unavailable_rows)
  const matrixRows = positiveInt(row.matrix_rows)
  const expectedMatrixRows = positiveInt(row.expected_matrix_rows)
  const persistedMatrixRows = positiveInt(row.persisted_matrix_rows)
  const blockers: string[] = []
  if (referenceRows <= 0) blockers.push('reference_universe_empty')
  if (identityRows !== referenceRows) blockers.push('reference_identity_incomplete')
  if (horizonRows + horizonUnavailableRows !== referenceRows) blockers.push('price_horizon_incomplete')
  if (expectedMatrixRows <= 0 || matrixRows !== expectedMatrixRows || persistedMatrixRows !== expectedMatrixRows) {
    blockers.push('canonical_strategy_matrix_incomplete')
  }
  if (labelRows + labelUnavailableRows !== referenceRows) blockers.push('canonical_labels_incomplete')
  if (!blockers.length) return null
  return {
    signalDate: row.signal_date,
    producerRunId: row.producer_run_id,
    referenceRows,
    identityRows,
    horizonRows,
    horizonUnavailableRows,
    labelRows,
    labelUnavailableRows,
    matrixRows,
    expectedMatrixRows,
    persistedMatrixRows,
    blockers,
  }
}

export function isMatureSelectionEvidenceGapRecoverable(gap: MatureSelectionEvidenceGap): boolean {
  return gap.referenceRows > 0
    && gap.identityRows === gap.referenceRows
    && gap.expectedMatrixRows > 0
    && gap.matrixRows === gap.expectedMatrixRows
    && gap.persistedMatrixRows === gap.expectedMatrixRows
}

export async function inspectMatureSelectionEvidenceGaps(
  env: Bindings,
  businessDateInput: string,
  options: { lookbackDays?: number } = {},
): Promise<{ matureSignalDate: string | null; inspectedDates: number; gaps: MatureSelectionEvidenceGap[] }> {
  const businessDate = dateOnly(businessDateInput, 'mature_selection_business_date')
  const matureSignalDate = await resolveExpectedMatureSignalDate(env, businessDate)
  if (!matureSignalDate) return { matureSignalDate: null, inspectedDates: 0, gaps: [] }
  const lookbackDays = Math.max(30, Math.min(540, Math.floor(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS)))
  const heads = await loadCanonicalHeads(env, shiftDate(matureSignalDate, -lookbackDays), matureSignalDate)
  const learningDb = databaseForDataDomain(env, 'learning')
  const loadedRows = await loadCoverageRows(learningDb, heads)
  const rowsByHead = new Map(
    loadedRows.map((row) => [`${row.signal_date}\u0000${row.producer_run_id}`, row]),
  )
  const rows = heads.map((head): CoverageRow => rowsByHead.get(
    `${head.signal_date}\u0000${head.run_id}`,
  ) ?? {
    signal_date: head.signal_date,
    producer_run_id: head.run_id,
    reference_rows: 0,
    identity_rows: 0,
    matrix_rows: 0,
    expected_matrix_rows: 0,
    persisted_matrix_rows: 0,
    horizon_rows: 0,
    horizon_unavailable_rows: 0,
    label_rows: 0,
    label_unavailable_rows: 0,
  })
  return {
    matureSignalDate,
    inspectedDates: rows.length,
    gaps: rows.map(toGap).filter((row): row is MatureSelectionEvidenceGap => row !== null),
  }
}

export async function recoverMatureSelectionEvidence(
  env: Bindings,
  businessDateInput: string,
  options: { lookbackDays?: number; maxRecoveryDates?: number } = {},
): Promise<MatureSelectionEvidenceRecoveryResult> {
  const businessDate = dateOnly(businessDateInput, 'mature_selection_business_date')
  const before = await inspectMatureSelectionEvidenceGaps(env, businessDate, options)
  const maxRecoveryDates = Math.max(
    1,
    Math.min(12, Math.floor(options.maxRecoveryDates ?? DEFAULT_MAX_RECOVERY_DATES)),
  )
  const recoverable = before.gaps.filter(isMatureSelectionEvidenceGapRecoverable)
  const blocked = before.gaps.filter((gap) => !isMatureSelectionEvidenceGapRecoverable(gap))
  const targeted = recoverable.slice(0, maxRecoveryDates)

  const { loadCanonicalScreenerRunIds } = await import('./historicalScreenerArtifactEvidence')
  const canonicalRunIds = targeted.length ? await loadCanonicalScreenerRunIds(env, businessDate) : {}

  let projectionRuns = 0
  let labelRowsPersisted = 0
  for (const gap of targeted) {
    if (gap.horizonRows + gap.horizonUnavailableRows !== gap.referenceRows) {
      await materializePriceHorizonLabels(env, {
        startDate: gap.signalDate,
        endDate: gap.signalDate,
        outcomeAsOfDate: businessDate,
        maxSignalDates: 1,
        maxProcessDates: 1,
        force: true,
      })
      projectionRuns += 1
    }
    if (gap.labelRows + gap.labelUnavailableRows !== gap.referenceRows) {
      const labels = await materializeCanonicalSelectionLabelsV4(
        databaseForDataDomain(env, 'learning'),
        { asOfDate: businessDate, startDate: gap.signalDate, endDate: gap.signalDate, canonicalRunIds },
      )
      labelRowsPersisted += labels.persisted_rows
    }
  }

  const after = await inspectMatureSelectionEvidenceGaps(env, businessDate, options)
  const targetedDates = new Set(targeted.map((gap) => gap.signalDate))
  const unresolvedTargeted = after.gaps.filter((gap) => targetedDates.has(gap.signalDate))
  if (unresolvedTargeted.length) {
    throw new Error(
      `mature_selection_evidence_recovery_incomplete:${unresolvedTargeted.map((gap) => (
        `${gap.signalDate}:${gap.blockers.join('|')}`
      )).join(',')}`,
    )
  }
  const recoveredDates = targeted.map((gap) => gap.signalDate)
  const summary = [
    `mature_signal_date=${before.matureSignalDate ?? 'none'}`,
    `inspected_dates=${before.inspectedDates}`,
    `gaps_before=${before.gaps.length}`,
    `targeted=${recoveredDates.join(',') || 'none'}`,
    `projection_runs=${projectionRuns}`,
    `labels_persisted=${labelRowsPersisted}`,
    `gaps_after=${after.gaps.length}`,
    `blocked=${blocked.map((gap) => gap.signalDate).join(',') || 'none'}`,
  ].join(' ')
  return {
    businessDate,
    matureSignalDate: before.matureSignalDate,
    inspectedDates: before.inspectedDates,
    gapDatesBefore: before.gaps.map((gap) => gap.signalDate),
    recoveredDates,
    gapDatesAfter: after.gaps.map((gap) => gap.signalDate),
    blockedDates: blocked.map((gap) => ({
      signalDate: gap.signalDate,
      blockers: gap.blockers,
    })),
    projectionRuns,
    labelRowsPersisted,
    summary,
  }
}
