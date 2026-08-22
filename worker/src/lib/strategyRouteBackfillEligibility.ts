import { CANONICAL_SELECTION_LABEL_SCHEMA_VERSION } from './canonicalSelectionLabels'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import { STRATEGY_ROUTE_CHALLENGER_VERSION } from './strategyRouteCalibration'
import {
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

type EligibilityRow = {
  signal_date: string
  producer_run_id: string
  reference_rows: number | string
  mature_label_rows: number | string
  matrix_rows: number | string
  expected_matrix_rows: number | string
  evaluable_matrix_rows: number | string
  matched_matrix_rows: number | string
  challenger_affinity_rows: number | string
  threshold_margin_rows: number | string
  challenger_route_rows: number | string
}

export type StrategyRouteBackfillEligibility = {
  signalDate: string
  producerRunId: string
  status: 'eligible' | 'unavailable' | 'pending_maturity'
  referenceRows: number
  matureLabelRows: number
  matrixRows: number
  evaluableMatrixRows: number
  matchedMatrixRows: number
  challengerAffinityRows: number
  thresholdMarginRows: number
  challengerRouteRows: number
  blockers: string[]
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

function shiftUtcDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`)
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10)
}

export async function auditStrategyRouteBackfillEligibility(
  db: D1Database,
  asOfDate: string,
  options: { startDate?: string; persist?: boolean; canonicalRunIds?: Record<string, string> } = {},
): Promise<StrategyRouteBackfillEligibility[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error(`invalid_strategy_route_eligibility_date:${asOfDate}`)
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.startDate ?? ''))
    ? String(options.startDate)
    : shiftUtcDate(asOfDate, -540)
  const result = await db.prepare(`
    WITH formal_runs AS (
      SELECT producer_run_id, signal_date, expected_cell_count, labeler_version
        FROM strategy_label_matrix_runs_v4
       WHERE status='ready' AND reference_contract_version=?
         AND labeler_version IN (?, ?)
    )
    SELECT r.signal_date, r.producer_run_id,
           COUNT(*) reference_rows,
           SUM(CASE WHEN EXISTS (
             SELECT 1 FROM canonical_selection_labels_v4 l
              WHERE l.signal_date=r.signal_date AND l.symbol=r.symbol
                AND l.producer_run_id=r.producer_run_id
                AND l.label_schema_version=? AND l.reference_contract_version=?
                AND l.outcome_known_date<=?
           ) THEN 1 ELSE 0 END) mature_label_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=r.signal_date AND m.producer_run_id=r.producer_run_id
                AND m.labeler_version=mr.labeler_version
           ), 0) matrix_rows,
           COALESCE(mr.expected_cell_count, 0) expected_matrix_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=r.signal_date AND m.producer_run_id=r.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.evaluable=1
           ), 0) evaluable_matrix_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=r.signal_date AND m.producer_run_id=r.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.evaluable=1 AND m.strategy_hit=1
           ), 0) matched_matrix_rows,
           SUM(CASE WHEN r.strategy_challenger_affinity_version=?
                    THEN 1 ELSE 0 END) challenger_affinity_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=r.signal_date AND m.producer_run_id=r.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0
           ), 0) threshold_margin_rows,
           SUM(CASE WHEN r.strategy_challenger_route_version=?
                     AND r.strategy_challenger_route_score IS NOT NULL
                    THEN 1 ELSE 0 END) challenger_route_rows
      FROM selection_reference_snapshots_v1 r
      JOIN formal_runs mr
        ON mr.signal_date=r.signal_date
       AND mr.producer_run_id=r.producer_run_id
       AND mr.labeler_version=r.strategy_labeler_version
     WHERE r.signal_date BETWEEN ? AND ?
       AND r.hard_gate_passed=1
       AND r.feature_contract_version=?
       AND EXISTS (
         SELECT 1 FROM json_each(?) h
          WHERE h.key=r.signal_date AND h.value=r.producer_run_id
       )
     GROUP BY r.signal_date, r.producer_run_id
     ORDER BY r.signal_date
  `).bind(
    SELECTION_REFERENCE_CONTRACT_VERSION,
    STRATEGY_FORMAL_LABELER_VERSION,
    STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
    CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
    SELECTION_REFERENCE_CONTRACT_VERSION,
    asOfDate,
    STRATEGY_ROUTE_CHALLENGER_VERSION,
    STRATEGY_ROUTE_CHALLENGER_VERSION,
    startDate,
    asOfDate,
    SELECTION_REFERENCE_CONTRACT_VERSION,
    JSON.stringify(options.canonicalRunIds ?? {}),
  ).all<EligibilityRow>()

  const output = (result.results ?? []).map((row): StrategyRouteBackfillEligibility => {
    const referenceRows = count(row.reference_rows)
    const matureLabelRows = count(row.mature_label_rows)
    const matrixRows = count(row.matrix_rows)
    const expectedMatrixRows = count(row.expected_matrix_rows)
    const evaluableMatrixRows = count(row.evaluable_matrix_rows)
    const matchedMatrixRows = count(row.matched_matrix_rows)
    const challengerAffinityRows = count(row.challenger_affinity_rows)
    const thresholdMarginRows = count(row.threshold_margin_rows)
    const challengerRouteRows = count(row.challenger_route_rows)
    const blockers: string[] = []
    if (referenceRows <= 0) blockers.push('canonical_reference_empty')
    if (matureLabelRows !== referenceRows) blockers.push('outcome_not_mature')
    if (expectedMatrixRows <= 0 || matrixRows !== expectedMatrixRows) blockers.push('canonical_strategy_matrix_missing')
    if (challengerAffinityRows !== referenceRows) blockers.push('challenger_affinity_version_missing')
    if (evaluableMatrixRows <= 0) blockers.push('strategy_matrix_no_evaluable_cells')
    if (matchedMatrixRows <= 0) blockers.push('strategy_matrix_no_strategy_hits')
    if (thresholdMarginRows !== matchedMatrixRows) blockers.push('threshold_margin_evidence_incomplete')
    if (challengerRouteRows !== referenceRows) {
      blockers.push('full_route_pit_inputs_not_persisted')
      blockers.push('challenger_route_score_missing')
    }
    const status = blockers.length === 1 && blockers[0] === 'outcome_not_mature'
      ? 'pending_maturity'
      : blockers.length
        ? 'unavailable'
        : 'eligible'
    return {
      signalDate: row.signal_date,
      producerRunId: row.producer_run_id,
      status,
      referenceRows,
      matureLabelRows,
      matrixRows,
      evaluableMatrixRows,
      matchedMatrixRows,
      challengerAffinityRows,
      thresholdMarginRows,
      challengerRouteRows,
      blockers,
    }
  })

  if (options.persist !== false) {
    for (let offset = 0; offset < output.length; offset += 100) {
      await db.batch(output.slice(offset, offset + 100).map((row) => db.prepare(`
        INSERT INTO strategy_route_backfill_eligibility_v1 (
          signal_date, producer_run_id, status, reference_rows, mature_label_rows,
          matrix_rows, evaluable_matrix_rows, matched_matrix_rows, challenger_affinity_rows,
          threshold_margin_rows, challenger_route_rows, blocker_json, audited_as_of_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signal_date, producer_run_id) DO UPDATE SET
          status=excluded.status,
          reference_rows=excluded.reference_rows,
          mature_label_rows=excluded.mature_label_rows,
          matrix_rows=excluded.matrix_rows,
          evaluable_matrix_rows=excluded.evaluable_matrix_rows,
          matched_matrix_rows=excluded.matched_matrix_rows,
          challenger_affinity_rows=excluded.challenger_affinity_rows,
          threshold_margin_rows=excluded.threshold_margin_rows,
          challenger_route_rows=excluded.challenger_route_rows,
          blocker_json=excluded.blocker_json,
          audited_as_of_date=excluded.audited_as_of_date,
          updated_at=CURRENT_TIMESTAMP
      `).bind(
        row.signalDate,
        row.producerRunId,
        row.status,
        row.referenceRows,
        row.matureLabelRows,
        row.matrixRows,
        row.evaluableMatrixRows,
        row.matchedMatrixRows,
        row.challengerAffinityRows,
        row.thresholdMarginRows,
        row.challengerRouteRows,
        JSON.stringify(row.blockers),
        asOfDate,
      )))
    }
  }
  return output
}
