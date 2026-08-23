import type { HistoricalScreenerArtifactEvidence } from './historicalScreenerArtifactEvidence'

type PreflightCountsRow = {
  decision_rows: number | string
  decision_symbols: number | string
  decision_strategies: number | string
  evaluation_contract_rows: number | string
  pit_packet_rows: number | string
  mature_label_rows: number | string
  rejected_label_rows: number | string
  reference_rows: number | string
  matrix_rows: number | string
  matrix_run_status: string | null
  matrix_run_expected_rows: number | string | null
}

export type HistoricalSelectionEvidenceRecoveryPreflight = {
  signalDate: string
  producerRunId: string
  status: 'retryable' | 'unavailable'
  retrySelector: boolean
  writeCanonical: false
  candidateCount: number
  strategyCount: number
  expectedCellCount: number
  decisionRows: number
  decisionSymbols: number
  decisionStrategies: number
  evaluationContractRows: number
  pitPacketRows: number
  matureLabelRows: number
  rejectedLabelRows: number
  referenceRows: number
  matrixRows: number
  matrixRunStatus: string | null
  routeRecoveryPacketReady: boolean
  routeRecoveryScoreCount: number
  parityReceiptPresent: boolean
  blockers: string[]
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

export async function auditHistoricalSelectionEvidenceRecoveryPreflight(
  db: D1Database,
  input: {
    signalDate: string
    producerRunId: string
    asOfDate: string
    artifactEvidence: HistoricalScreenerArtifactEvidence | null
  },
): Promise<HistoricalSelectionEvidenceRecoveryPreflight> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signalDate)) {
    throw new Error(`invalid_historical_recovery_signal_date:${input.signalDate}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate) || input.asOfDate < input.signalDate) {
    throw new Error(`invalid_historical_recovery_as_of_date:${input.asOfDate}`)
  }
  if (!input.producerRunId.trim()) throw new Error('historical_recovery_producer_run_id_missing')

  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM strategy_decision_log d WHERE d.date=?) decision_rows,
      (SELECT COUNT(DISTINCT symbol) FROM strategy_decision_log d WHERE d.date=?) decision_symbols,
      (SELECT COUNT(DISTINCT strategy_id || '|' || strategy_version)
         FROM strategy_decision_log d WHERE d.date=?) decision_strategies,
      (SELECT COUNT(*) FROM strategy_decision_log d
        WHERE d.date=? AND d.evaluation_contract_version='strategy-evaluation-v2') evaluation_contract_rows,
      (SELECT COUNT(*) FROM strategy_decision_log d
        WHERE d.date=? AND json_valid(d.evidence_json)
          AND json_extract(d.evidence_json, '$.pit_reconstruction.schema_version')='strategy-decision-pit-reconstruction-v5'
          AND json_extract(d.evidence_json, '$.pit_reconstruction.no_lookahead')=1
          AND json_extract(d.evidence_json, '$.pit_reconstruction.knowledge_cutoff')=?) pit_packet_rows,
      (SELECT COUNT(*) FROM canonical_selection_labels_v4 l
        WHERE l.signal_date=? AND l.producer_run_id=? AND l.outcome_known_date<=?) mature_label_rows,
      (SELECT COUNT(*) FROM canonical_selection_label_rejections_v4 q
        WHERE q.signal_date=? AND q.producer_run_id=?) rejected_label_rows,
      (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r
        WHERE r.signal_date=? AND r.producer_run_id=? AND r.hard_gate_passed=1) reference_rows,
      (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
        WHERE m.signal_date=? AND m.producer_run_id=?) matrix_rows,
      (SELECT status FROM strategy_label_matrix_runs_v4 mr
        WHERE mr.signal_date=? AND mr.producer_run_id=?) matrix_run_status,
      (SELECT expected_cell_count FROM strategy_label_matrix_runs_v4 mr
        WHERE mr.signal_date=? AND mr.producer_run_id=?) matrix_run_expected_rows
  `).bind(
    input.signalDate,
    input.signalDate,
    input.signalDate,
    input.signalDate,
    input.signalDate, input.signalDate,
    input.signalDate, input.producerRunId, input.asOfDate,
    input.signalDate, input.producerRunId,
    input.signalDate, input.producerRunId,
    input.signalDate, input.producerRunId,
    input.signalDate, input.producerRunId,
    input.signalDate, input.producerRunId,
  ).first<PreflightCountsRow>()

  const artifact = input.artifactEvidence
  const candidateCount = nonNegativeInteger(artifact?.candidate_count)
  const strategyCount = nonNegativeInteger(artifact?.strategy_count)
  const expectedCellCount = nonNegativeInteger(artifact?.expected_cell_count)
  const decisionRows = nonNegativeInteger(row?.decision_rows)
  const decisionSymbols = nonNegativeInteger(row?.decision_symbols)
  const decisionStrategies = nonNegativeInteger(row?.decision_strategies)
  const evaluationContractRows = nonNegativeInteger(row?.evaluation_contract_rows)
  const pitPacketRows = nonNegativeInteger(row?.pit_packet_rows)
  const matureLabelRows = nonNegativeInteger(row?.mature_label_rows)
  const rejectedLabelRows = nonNegativeInteger(row?.rejected_label_rows)
  const referenceRows = nonNegativeInteger(row?.reference_rows)
  const matrixRows = nonNegativeInteger(row?.matrix_rows)
  const routeRecoveryScoreCount = nonNegativeInteger(artifact?.route_recovery_score_count)
  const parityReceiptPresent = /^sha256:[a-f0-9]{64}$/i.test(
    artifact?.route_recovery_parity_checksum ?? '',
  )
  const blockers: string[] = []

  if (!artifact) blockers.push('canonical_r2_screener_artifact_missing_or_unverified')
  if (candidateCount <= 0 || strategyCount <= 0 || expectedCellCount !== candidateCount * strategyCount) {
    blockers.push('artifact_candidate_strategy_grid_invalid')
  }
  if (
    decisionRows !== expectedCellCount
    || decisionSymbols !== candidateCount
    || decisionStrategies !== strategyCount
  ) blockers.push('decision_grid_incomplete')
  if (evaluationContractRows !== decisionRows) blockers.push('decision_evaluation_contract_incomplete')
  if (pitPacketRows !== decisionRows) blockers.push('decision_pit_packet_incomplete')
  if (matureLabelRows + rejectedLabelRows !== candidateCount) blockers.push('outcome_resolution_incomplete')
  if (!artifact?.route_recovery_packet_ready) blockers.push('immutable_route_recovery_packet_missing')
  if (routeRecoveryScoreCount !== candidateCount) {
    blockers.push(`challenger_route_score_coverage_incomplete:${routeRecoveryScoreCount}/${candidateCount}`)
  }
  if (!parityReceiptPresent) blockers.push('route_score_parity_receipt_missing')
  if (referenceRows !== candidateCount) blockers.push('canonical_reference_carrier_missing')
  if (
    matrixRows !== expectedCellCount
    || row?.matrix_run_status !== 'ready'
    || nonNegativeInteger(row?.matrix_run_expected_rows) !== expectedCellCount
  ) blockers.push('canonical_strategy_matrix_carrier_missing')

  const retrySelector = blockers.length === 0
  return {
    signalDate: input.signalDate,
    producerRunId: input.producerRunId,
    status: retrySelector ? 'retryable' : 'unavailable',
    retrySelector,
    writeCanonical: false,
    candidateCount,
    strategyCount,
    expectedCellCount,
    decisionRows,
    decisionSymbols,
    decisionStrategies,
    evaluationContractRows,
    pitPacketRows,
    matureLabelRows,
    rejectedLabelRows,
    referenceRows,
    matrixRows,
    matrixRunStatus: row?.matrix_run_status ?? null,
    routeRecoveryPacketReady: artifact?.route_recovery_packet_ready === true,
    routeRecoveryScoreCount,
    parityReceiptPresent,
    blockers,
  }
}

export function referenceLineageRecoveryRetryAllowed(
  blockerReason: string | null | undefined,
  preflight: HistoricalSelectionEvidenceRecoveryPreflight | null | undefined,
): boolean {
  return String(blockerReason ?? '').startsWith('reference_lineage_incomplete')
    && preflight?.status === 'retryable'
    && preflight.retrySelector === true
    && preflight.writeCanonical === false
}
