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
// One 24-head page reads about 1M rows; two back to back exceed D1's 10-second
// resource window ("D1 DB is overloaded"). Smaller pages, a pause between them
// and a wait past that window before retrying keep the scan under it. With
// 1.5 s pauses about three pages still landed in one window on 2026-11-04. An
// 8-head page took 3.2 s on 2026-11-06, so a 5 s pause still put two pages in
// one window whenever another learning-db reader shared it; 10 s keeps a page
// alone in its window.
const HEAD_PAGE_SIZE = 8
const PAGE_PAUSE_MS = 10_000
const OVERLOAD_RETRY_DELAY_MS = 12_000
const OVERLOAD_MAX_ATTEMPTS = 3

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
  afterInspection?: MatureSelectionEvidenceInspection
}

type MatureSelectionEvidenceInspection = {
  matureSignalDate: string | null
  inspectedDates: number
  scannedDates: number
  gaps: MatureSelectionEvidenceGap[]
}

type InspectOptions = {
  lookbackDays?: number
  // Restrict the coverage scan to these heads (a recovery's after-check).
  heads?: Array<{ signalDate: string; producerRunId: string }>
  // Tests only: the pause between coverage pages.
  pagePauseMs?: number
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isD1Overloaded(error: unknown): boolean {
  return /D1 DB is overloaded/i.test(error instanceof Error ? error.message : String(error))
}

async function withOverloadRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isD1Overloaded(error) || attempt >= OVERLOAD_MAX_ATTEMPTS) throw error
      await sleep(OVERLOAD_RETRY_DELAY_MS)
    }
  }
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
  onPage?: (page: CanonicalHeadRow[], rows: CoverageRow[]) => Promise<void>,
  pagePauseMs: number = PAGE_PAUSE_MS,
): Promise<CoverageRow[]> {
  const output: CoverageRow[] = []
  const pages = chunks(heads, HEAD_PAGE_SIZE)
  for (const [pageIndex, page] of pages.entries()) {
    if (pageIndex > 0) await sleep(pagePauseMs)
    const targetRows = page.map(() => '(?, ?)').join(', ')
    const binds = page.flatMap((row) => [row.signal_date, row.run_id])
    const result = await withOverloadRetry(() => db.prepare(`
      WITH target_heads(signal_date, producer_run_id) AS (
        VALUES ${targetRows}
      ),
      formal_runs AS MATERIALIZED (
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
      matrix_counts AS MATERIALIZED (
        -- Only lineages that can join (formal runs) are counted, one probe each:
        -- grouping every matrix row of the date sorted it through a temp b-tree,
        -- doubling the dominant read. A lineage without rows yields 0 where the
        -- grouped form yielded no row; the outer COALESCE(MAX(...),0) is the same.
        SELECT k.signal_date, k.producer_run_id, k.labeler_version, k.reference_contract_version,
               (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
                 WHERE m.signal_date=k.signal_date AND m.producer_run_id=k.producer_run_id
                   AND m.labeler_version=k.labeler_version
                   AND m.reference_contract_version=k.reference_contract_version) matrix_rows
          FROM (SELECT DISTINCT signal_date, producer_run_id, labeler_version, reference_contract_version
                  FROM formal_runs) k
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
        FROM target_heads t
        CROSS JOIN selection_reference_snapshots_v1 r
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
    ).all<CoverageRow>())
    output.push(...(result.results ?? []))
    if (onPage) await onPage(page, result.results ?? [])
  }
  return output
}

function emptyCoverageRow(head: CanonicalHeadRow): CoverageRow {
  return {
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
  }
}

function headKey(signalDate: string, runId: string): string {
  return `${signalDate}|${runId}`
}

// Re-reading every complete head on each inspection (~120 heads, ~3M learning-db
// rows, up to four inspections a night) kept D1 at its 10-second overload window
// (2026-11-04, -05). Inspections scan unverified heads plus one rolling page of
// the oldest verifications, so a complete head that later regresses is still
// found within a few nights. The markers are only an optimisation: a KV failure
// falls back to the full scan instead of failing the inspection.
const VERIFIED_HEADS_KEY = 'mature-selection-evidence:verified-heads:v1'
// Bump when the coverage SQL or toGap changes what "complete" means.
const COVERAGE_LOGIC_VERSION = 'mature-coverage-logic-v1'
const VERIFIED_HEADS_CONTRACT = [
  COVERAGE_LOGIC_VERSION,
  SELECTION_REFERENCE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  PRICE_HORIZON_PROJECTION_VERSION,
  CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
  CANONICAL_SELECTION_ADJUSTMENT_SOURCE,
].join('|')

async function readVerifiedHeads(env: Bindings): Promise<Record<string, string> | null> {
  if (!env.KV) return null
  let stored: { contract?: unknown; heads?: unknown } | null
  try {
    stored = await env.KV.get(VERIFIED_HEADS_KEY, 'json') as typeof stored
  } catch (error) {
    console.warn(`[MatureSelectionEvidence] verified heads unreadable, full scan: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (stored?.contract !== VERIFIED_HEADS_CONTRACT || !stored.heads || typeof stored.heads !== 'object') return {}
  return Object.fromEntries(Object.entries(stored.heads as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
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
  options: InspectOptions = {},
): Promise<MatureSelectionEvidenceInspection> {
  const businessDate = dateOnly(businessDateInput, 'mature_selection_business_date')
  const matureSignalDate = await resolveExpectedMatureSignalDate(env, businessDate)
  if (!matureSignalDate) return { matureSignalDate: null, inspectedDates: 0, scannedDates: 0, gaps: [] }
  const lookbackDays = Math.max(30, Math.min(540, Math.floor(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS)))
  const windowStart = shiftDate(matureSignalDate, -lookbackDays)
  const liveHeads = await loadCanonicalHeads(env, windowStart, matureSignalDate)
  // A scoped inspection (after a recovery) pages only the heads it is given;
  // the marker housekeeping below still sees every live head.
  const only = options.heads
    ? new Set(options.heads.map((head) => headKey(head.signalDate, head.producerRunId)))
    : null
  const heads = only ? liveHeads.filter((head) => only.has(headKey(head.signal_date, head.run_id))) : liveHeads
  const learningDb = databaseForDataDomain(env, 'learning')
  const verified = await readVerifiedHeads(env)
  let scanHeads = heads
  let onPage: ((page: CanonicalHeadRow[], rows: CoverageRow[]) => Promise<void>) | undefined
  if (verified) {
    const live = new Set(liveHeads.map((head) => headKey(head.signal_date, head.run_id)))
    // A historical replay sees an earlier window; markers newer than it stay.
    const oldestKept = shiftDate(matureSignalDate, -540)
    for (const key of Object.keys(verified)) {
      const date = key.slice(0, 10)
      if (date < oldestKept || (date >= windowStart && date <= matureSignalDate && !live.has(key))) delete verified[key]
    }
    const recheck = new Set(heads
      .map((head) => headKey(head.signal_date, head.run_id))
      .filter((key) => verified[key])
      .sort((a, b) => verified[a].localeCompare(verified[b]) || a.localeCompare(b))
      .slice(0, HEAD_PAGE_SIZE))
    // Unverified heads go first so a retry after an overload spends its first
    // pages on new heads rather than on the recheck page.
    scanHeads = [
      ...heads.filter((head) => !verified[headKey(head.signal_date, head.run_id)]),
      ...heads.filter((head) => recheck.has(headKey(head.signal_date, head.run_id))),
    ]
    let writable = true
    // Saved after every page so an overloaded inspection still keeps its progress.
    onPage = async (page, pageRows) => {
      const byHead = new Map(pageRows.map((row) => [headKey(row.signal_date, row.producer_run_id), row]))
      const verifiedAt = new Date().toISOString()
      for (const head of page) {
        const key = headKey(head.signal_date, head.run_id)
        if (toGap(byHead.get(key) ?? emptyCoverageRow(head)) === null) verified[key] = verifiedAt
        else delete verified[key]
      }
      if (!writable) return
      try {
        await env.KV.put(VERIFIED_HEADS_KEY, JSON.stringify({ contract: VERIFIED_HEADS_CONTRACT, heads: verified }))
      } catch (error) {
        writable = false
        console.warn(`[MatureSelectionEvidence] verified heads not saved: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const loadedRows = await loadCoverageRows(learningDb, scanHeads, onPage, options.pagePauseMs)
  const rowsByHead = new Map(
    loadedRows.map((row) => [headKey(row.signal_date, row.producer_run_id), row]),
  )
  const scanned = new Set(scanHeads.map((head) => headKey(head.signal_date, head.run_id)))
  const rows = heads.filter((head) => scanned.has(headKey(head.signal_date, head.run_id))).map((head): CoverageRow => rowsByHead.get(
    headKey(head.signal_date, head.run_id),
  ) ?? emptyCoverageRow(head))
  return {
    matureSignalDate,
    inspectedDates: liveHeads.length,
    scannedDates: scanHeads.length,
    gaps: rows.map(toGap).filter((row): row is MatureSelectionEvidenceGap => row !== null),
  }
}

// The inspection after a recovery covers only the targeted heads; every other
// head keeps the gap (or none) the inspection before the recovery found.
export function mergeTargetedInspection(
  before: MatureSelectionEvidenceInspection,
  targetedKeys: Set<string>,
  afterTargeted: MatureSelectionEvidenceInspection | null,
): MatureSelectionEvidenceInspection {
  if (!afterTargeted) return before
  return {
    matureSignalDate: before.matureSignalDate,
    inspectedDates: before.inspectedDates,
    scannedDates: afterTargeted.scannedDates,
    gaps: [
      ...before.gaps.filter((gap) => !targetedKeys.has(headKey(gap.signalDate, gap.producerRunId))),
      ...afterTargeted.gaps,
    ],
  }
}

export async function recoverMatureSelectionEvidence(
  env: Bindings,
  businessDateInput: string,
  options: { lookbackDays?: number; maxRecoveryDates?: number; before?: MatureSelectionEvidenceInspection; pagePauseMs?: number } = {},
): Promise<MatureSelectionEvidenceRecoveryResult> {
  const businessDate = dateOnly(businessDateInput, 'mature_selection_business_date')
  const inspectOptions: InspectOptions = { lookbackDays: options.lookbackDays, pagePauseMs: options.pagePauseMs }
  // Each inspection reads several million learning-db rows; reuse the caller's.
  const before = options.before ?? await inspectMatureSelectionEvidenceGaps(env, businessDate, inspectOptions)
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

  // Nothing else writes these tables during a recovery, so only the targeted
  // heads can have changed. Re-inspecting every unverified head after each
  // batch repeated the dominant learning-db read up to four times a night
  // (2026-11-06); the after-check pages the targeted heads alone.
  const targetedKeys = new Set(targeted.map((gap) => headKey(gap.signalDate, gap.producerRunId)))
  const afterTargeted = targeted.length
    ? await inspectMatureSelectionEvidenceGaps(env, businessDate, {
      ...inspectOptions,
      heads: targeted.map((gap) => ({ signalDate: gap.signalDate, producerRunId: gap.producerRunId })),
    })
    : null
  const after = mergeTargetedInspection(before, targetedKeys, afterTargeted)
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
    afterInspection: after,
  }
}

export async function drainMatureSelectionEvidence(
  env: Bindings,
  businessDateInput: string,
  options: { lookbackDays?: number; maxRecoveryDates?: number; maxBatches?: number; pagePauseMs?: number } = {},
): Promise<MatureSelectionEvidenceRecoveryResult> {
  const businessDate = dateOnly(businessDateInput, 'mature_selection_business_date')
  const inspectOptions: InspectOptions = { lookbackDays: options.lookbackDays, pagePauseMs: options.pagePauseMs }
  const initial = await inspectMatureSelectionEvidenceGaps(env, businessDate, inspectOptions)
  const recoveredDates: string[] = []
  let projectionRuns = 0
  let labelRowsPersisted = 0
  const maxBatches = Math.max(1, Math.min(4, Math.floor(options.maxBatches ?? 3)))

  // Nothing else writes these tables during the drain, so the last inspection
  // stays current; re-scanning between batches only multiplied the reads.
  let current = initial
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const recoverable = current.gaps.filter(isMatureSelectionEvidenceGapRecoverable)
    if (!recoverable.length) break
    const result = await recoverMatureSelectionEvidence(env, businessDate, {
      lookbackDays: options.lookbackDays,
      maxRecoveryDates: options.maxRecoveryDates ?? DEFAULT_MAX_RECOVERY_DATES,
      before: current,
      pagePauseMs: options.pagePauseMs,
    })
    recoveredDates.push(...result.recoveredDates)
    projectionRuns += result.projectionRuns
    labelRowsPersisted += result.labelRowsPersisted
    current = result.afterInspection ?? await inspectMatureSelectionEvidenceGaps(env, businessDate, inspectOptions)
    if (!result.recoveredDates.length) break
  }

  const after = current
  const remainingRecoverable = after.gaps.filter(isMatureSelectionEvidenceGapRecoverable)
  if (remainingRecoverable.length) {
    throw new Error(
      `mature_selection_evidence_backlog_not_drained:${remainingRecoverable.map((gap) => (
        `${gap.signalDate}:${gap.blockers.join('|')}`
      )).join(',')}`,
    )
  }
  const blocked = after.gaps.filter((gap) => !isMatureSelectionEvidenceGapRecoverable(gap))
  const uniqueRecoveredDates = [...new Set(recoveredDates)].sort()
  const summary = [
    `mature_signal_date=${initial.matureSignalDate ?? 'none'}`,
    `inspected_dates=${initial.inspectedDates}`,
    `scanned_dates=${initial.scannedDates}`,
    `gaps_before=${initial.gaps.length}`,
    `targeted=${uniqueRecoveredDates.join(',') || 'none'}`,
    `projection_runs=${projectionRuns}`,
    `labels_persisted=${labelRowsPersisted}`,
    `gaps_after=${after.gaps.length}`,
    `recoverable_after=0`,
    `blocked=${blocked.map((gap) => gap.signalDate).join(',') || 'none'}`,
  ].join(' ')
  return {
    businessDate,
    matureSignalDate: initial.matureSignalDate,
    inspectedDates: initial.inspectedDates,
    gapDatesBefore: initial.gaps.map((gap) => gap.signalDate),
    recoveredDates: uniqueRecoveredDates,
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
