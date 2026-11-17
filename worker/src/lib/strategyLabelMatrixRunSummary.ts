// Per-run cell counts of strategy_label_matrix_v4, kept on the run header
// (strategy_label_matrix_runs_v4.summary_*, learning migration 0065) so the
// evening closure, maturity and rebuild readers stop recounting about 21k
// cells per (signal_date, producer_run_id) on every call.
//
// Writers: the promotion batch of persistSelectionEvidenceV4 (same transaction
// as the cells) and the challenger projection of
// rebuildHistoricalStrategyEvidenceV5, which clears the summary before it
// rewrites cells and refreshes it afterwards. Any other code that changes or
// deletes matrix cells of a ready run must clear summary_version first.
//
// Readers use a summary only when summary_version equals the version built
// from their own challenger version and every cell matched the header's
// labeler, registry checksum and reference contract
// (summary_contract_rows=summary_matrix_rows). Otherwise, and for runs
// promoted before 0065 (summary_version NULL), they count the cells as before.

export const MATRIX_RUN_SUMMARY_SCHEMA = 'matrix-run-summary-v1'
// The challenger affinity version counted by summary_challenger_projection_rows
// and summary_projected_threshold_rows. Pinned to STRATEGY_AFFINITY_CHALLENGER_VERSION
// and STRATEGY_ROUTE_AFFINITY_VERSION by strategyLabelMatrixRunSummary.test.ts.
export const MATRIX_RUN_SUMMARY_CHALLENGER_VERSION = 'strategy-threshold-margin-affinity-v2'

export function matrixRunSummaryVersion(challengerAffinityVersion: string): string {
  return `${MATRIX_RUN_SUMMARY_SCHEMA}|${challengerAffinityVersion}`
}

export const MATRIX_RUN_SUMMARY_VERSION = matrixRunSummaryVersion(MATRIX_RUN_SUMMARY_CHALLENGER_VERSION)

// SQL predicate: the header row aliased `alias` carries a summary that the
// reader may use. Binds one value: matrixRunSummaryVersion(<reader's challenger version>).
export function matrixRunSummaryUsable(alias: string): string {
  return `(${alias}.status='ready' AND ${alias}.summary_version=?`
    + ` AND ${alias}.summary_contract_rows=${alias}.summary_matrix_rows)`
}

// Same predicate with the version inlined, for SQL whose bind order is fixed.
export function matrixRunSummaryUsableInline(alias: string, challengerAffinityVersion: string): string {
  const version = matrixRunSummaryVersion(challengerAffinityVersion)
  if (!/^[A-Za-z0-9._|:-]+$/.test(version)) throw new Error(`matrix_run_summary_version_invalid:${version}`)
  return matrixRunSummaryUsable(alias).replace('?', `'${version}'`)
}

// Recounts the cells of one ready run into its header. Binds, in order:
// MATRIX_RUN_SUMMARY_CHALLENGER_VERSION twice, MATRIX_RUN_SUMMARY_VERSION,
// producer_run_id, signal_date, then the binds of `extraWhere`. It reads the
// run's cells once through the matrix primary key (signal_date leading) and
// leaves updated_at unchanged: the header's identity did not change, and
// listHistoricalStrategyEvidenceV5Dates reads updated_at as "run replaced".
export function matrixRunSummaryRefreshSql(extraWhere = ''): string {
  return `
    UPDATE strategy_label_matrix_runs_v4 AS mr
       SET (summary_matrix_rows, summary_contract_rows, summary_evaluable_rows,
            summary_matched_rows, summary_threshold_evidence_rows,
            summary_challenger_projection_rows, summary_projected_threshold_rows,
            summary_version) = (
         SELECT COUNT(*),
                COALESCE(SUM(CASE
                  WHEN m.labeler_version=mr.labeler_version
                   AND m.strategy_registry_checksum=mr.strategy_registry_checksum
                   AND m.reference_contract_version=mr.reference_contract_version
                  THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN m.evaluable=1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN m.evaluable=1 AND m.strategy_hit=1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN m.evaluable=1 AND m.strategy_hit=1
                                   AND m.affinity_evidence_count>0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN m.challenger_affinity_version=? THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN m.evaluable=1 AND m.strategy_hit=1
                                   AND m.affinity_evidence_count>0
                                   AND m.challenger_affinity_version=? THEN 1 ELSE 0 END), 0),
                ?
           FROM strategy_label_matrix_v4 m
          WHERE m.signal_date=mr.signal_date AND m.producer_run_id=mr.producer_run_id
       )
     WHERE mr.producer_run_id=? AND mr.signal_date=? AND mr.status='ready'${extraWhere}
  `
}

export function matrixRunSummaryRefreshBinds(producerRunId: string, signalDate: string): string[] {
  return [
    MATRIX_RUN_SUMMARY_CHALLENGER_VERSION,
    MATRIX_RUN_SUMMARY_CHALLENGER_VERSION,
    MATRIX_RUN_SUMMARY_VERSION,
    producerRunId,
    signalDate,
  ]
}

// Clears a run's summary before its cells change, so a crash between the cell
// writes and the refresh leaves readers on the live count, never a stale one.
export const MATRIX_RUN_SUMMARY_CLEAR_SQL = `
    UPDATE strategy_label_matrix_runs_v4
       SET summary_version=NULL
     WHERE producer_run_id=? AND signal_date=?
  `

export interface MatrixRunSummaryCounts {
  matrixRows: number
  contractRows: number
  evaluableRows: number
  matchedRows: number
  thresholdEvidenceRows: number
  challengerProjectionRows: number
  projectedThresholdRows: number
}

// Header columns to select (alias `mr`) next to matrixRunSummaryUsable('mr') AS summary_usable.
export const MATRIX_RUN_SUMMARY_SELECT = `
    mr.summary_matrix_rows, mr.summary_contract_rows, mr.summary_evaluable_rows,
    mr.summary_matched_rows, mr.summary_threshold_evidence_rows,
    mr.summary_challenger_projection_rows, mr.summary_projected_threshold_rows`

type SummaryRow = {
  summary_usable?: number | string | null
  summary_matrix_rows?: number | string | null
  summary_contract_rows?: number | string | null
  summary_evaluable_rows?: number | string | null
  summary_matched_rows?: number | string | null
  summary_threshold_evidence_rows?: number | string | null
  summary_challenger_projection_rows?: number | string | null
  summary_projected_threshold_rows?: number | string | null
}

export function matrixRunSummaryCounts(row: SummaryRow | null | undefined): MatrixRunSummaryCounts | null {
  if (!row || Number(row.summary_usable) !== 1) return null
  const values = [
    row.summary_matrix_rows, row.summary_contract_rows, row.summary_evaluable_rows,
    row.summary_matched_rows, row.summary_threshold_evidence_rows,
    row.summary_challenger_projection_rows, row.summary_projected_threshold_rows,
  ].map((value) => (value == null ? Number.NaN : Number(value)))
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return null
  const [
    matrixRows, contractRows, evaluableRows, matchedRows,
    thresholdEvidenceRows, challengerProjectionRows, projectedThresholdRows,
  ] = values
  return {
    matrixRows, contractRows, evaluableRows, matchedRows,
    thresholdEvidenceRows, challengerProjectionRows, projectedThresholdRows,
  }
}

// The usable summary of one ready run, or null (count the cells instead).
// One PK lookup on the header; never touches the matrix.
export async function readMatrixRunSummary(
  db: D1Database,
  signalDate: string,
  producerRunId: string,
  challengerAffinityVersion: string,
): Promise<MatrixRunSummaryCounts | null> {
  const row = await db.prepare(`
    SELECT ${matrixRunSummaryUsable('mr')} AS summary_usable,${MATRIX_RUN_SUMMARY_SELECT}
      FROM strategy_label_matrix_runs_v4 mr
     WHERE mr.producer_run_id=? AND mr.signal_date=? AND mr.status='ready'
  `).bind(matrixRunSummaryVersion(challengerAffinityVersion), producerRunId, signalDate).first<SummaryRow>()
  return matrixRunSummaryCounts(row)
}
