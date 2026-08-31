import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
} from './selectionReferenceEvidence'
import {
  CANONICAL_SELECTION_ADJUSTMENT_SOURCE,
  CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
} from './canonicalSelectionLabels'
import { PRICE_HORIZON_PROJECTION_VERSION } from './priceHorizonProjection'
import { STRATEGY_ROUTE_AFFINITY_VERSION } from './strategyRouteCalibration'
import {
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'
import {
  inspectMatureSelectionEvidenceGaps,
  isMatureSelectionEvidenceGapRecoverable,
  resolveExpectedMatureSignalDate,
} from './matureSelectionEvidenceRecovery'

export type EveningChainEvidenceClosure = {
  businessDate: string
  referenceRows: number
  referenceIdentityRows: number
  referenceArtifactRows: number
  referenceProjectionRows: number
  decisionReconciledRows: number
  matrixRows: number
  expectedMatrixRows: number
  matchedMatrixRows: number
  challengerProjectionRows: number
  projectedThresholdRows: number
  thresholdEvidenceRows: number
  similarityArtifactStatus: string
  sectorRows: number
  sectorBreadthRows: number
  matureSignalDate: string | null
  matureReferenceRows: number
  priceHorizonRows: number
  priceHorizonUnavailableRows: number
  canonicalLabelRows: number
  matureBlockedDates: string[]
  canonicalUnavailableRows: number
  matureBacklogDates: string[]
}

function dateOnly(value: unknown): string {
  const date = String(value ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid_evening_chain_closure_date:${value}`)
  return date
}

export { resolveExpectedMatureSignalDate } from './matureSelectionEvidenceRecovery'

export async function auditEveningChainEvidenceClosure(
  env: Bindings,
  businessDateInput: string,
  producerRunIdInput: string,
  options: { requireSectorBreadth?: boolean } = {},
): Promise<EveningChainEvidenceClosure> {
  const businessDate = dateOnly(businessDateInput)
  const producerRunId = String(producerRunIdInput ?? '').trim()
  if (!producerRunId) throw new Error('evening_chain_closure_producer_run_id_missing')
  const marketDb = databaseForDataDomain(env, 'market')
  const learningDb = databaseForDataDomain(env, 'learning')
  const opsDb = databaseForDataDomain(env, 'ops')

  const current = await learningDb.prepare(`
    SELECT COUNT(*) reference_rows,
           SUM(CASE WHEN r.stock_id IS NOT NULL THEN 1 ELSE 0 END) identity_rows,
           SUM(CASE WHEN r.evidence_artifact_id IS NOT NULL THEN 1 ELSE 0 END) artifact_rows,
           SUM(CASE WHEN r.decision_evidence_reconciled_at IS NOT NULL THEN 1 ELSE 0 END) reconciled_rows,
           SUM(CASE WHEN r.strategy_challenger_affinity_version=? THEN 1 ELSE 0 END) reference_projection_rows
      FROM selection_reference_snapshots_v1 r
     WHERE r.signal_date=?
       AND r.hard_gate_passed=1
       AND r.feature_contract_version=?
       AND r.producer_run_id=?
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.signal_date=r.signal_date
            AND mr.producer_run_id=r.producer_run_id
            AND mr.status='ready'
            AND mr.reference_contract_version=?
            AND mr.labeler_version IN (?, ?)
            AND mr.labeler_version=r.strategy_labeler_version
       )
  `).bind(
    STRATEGY_ROUTE_AFFINITY_VERSION,
    businessDate,
    SELECTION_REFERENCE_CONTRACT_VERSION,
    producerRunId,
    SELECTION_REFERENCE_CONTRACT_VERSION,
    STRATEGY_FORMAL_LABELER_VERSION,
    STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
  ).first<any>()
  const referenceRows = Number(current?.reference_rows ?? 0)
  const referenceIdentityRows = Number(current?.identity_rows ?? 0)
  const referenceArtifactRows = Number(current?.artifact_rows ?? 0)
  const decisionReconciledRows = Number(current?.reconciled_rows ?? 0)
  const referenceProjectionRows = Number(current?.reference_projection_rows ?? 0)
  if (referenceRows <= 0) throw new Error(`evening_chain_reference_universe_missing:${businessDate}`)
  if (referenceIdentityRows !== referenceRows) {
    throw new Error(`evening_chain_reference_identity_incomplete:${referenceIdentityRows}/${referenceRows}`)
  }
  if (referenceArtifactRows !== referenceRows) {
    throw new Error(`evening_chain_reference_artifact_incomplete:${referenceArtifactRows}/${referenceRows}`)
  }
  if (decisionReconciledRows !== referenceRows) {
    throw new Error(`evening_chain_decision_reconciliation_incomplete:${decisionReconciledRows}/${referenceRows}`)
  }

  const matrix = await learningDb.prepare(`
    SELECT r.expected_cell_count, r.persisted_cell_count,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version) matrix_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0) threshold_evidence_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.challenger_affinity_version=?) challenger_projection_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) projected_threshold_rows
      FROM strategy_label_matrix_runs_v4 r
     WHERE r.signal_date=? AND r.status='ready' AND r.producer_run_id=?
       AND r.reference_contract_version=?
       AND r.labeler_version IN (?, ?)
     LIMIT 1
  `).bind(
    STRATEGY_ROUTE_AFFINITY_VERSION,
    STRATEGY_ROUTE_AFFINITY_VERSION,
    businessDate,
    producerRunId,
    SELECTION_REFERENCE_CONTRACT_VERSION,
    STRATEGY_FORMAL_LABELER_VERSION,
    STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
  ).first<any>()
  const matrixRows = Number(matrix?.matrix_rows ?? 0)
  const expectedMatrixRows = Number(matrix?.expected_cell_count ?? 0)
  const matchedMatrixRows = Number(matrix?.matched_rows ?? 0)
  const thresholdEvidenceRows = Number(matrix?.threshold_evidence_rows ?? 0)
  const challengerProjectionRows = Number(matrix?.challenger_projection_rows ?? 0)
  const projectedThresholdRows = Number(matrix?.projected_threshold_rows ?? 0)
  if (
    expectedMatrixRows <= 0
    || Number(matrix?.persisted_cell_count ?? 0) !== expectedMatrixRows
    || matrixRows !== expectedMatrixRows
  ) {
    throw new Error(`evening_chain_strategy_matrix_incomplete:${matrixRows}/${expectedMatrixRows}`)
  }

  if (matchedMatrixRows <= 0 || thresholdEvidenceRows !== matchedMatrixRows) {
    throw new Error(`evening_chain_threshold_margin_evidence_incomplete:${thresholdEvidenceRows}/${matchedMatrixRows}`)
  }
  if (referenceProjectionRows !== referenceRows || challengerProjectionRows !== expectedMatrixRows || projectedThresholdRows !== matchedMatrixRows) {
    throw new Error(`evening_chain_challenger_affinity_projection_incomplete:${referenceProjectionRows}/${referenceRows}:${challengerProjectionRows}/${expectedMatrixRows}:${projectedThresholdRows}/${matchedMatrixRows}`)
  }


  const similarity = await learningDb.prepare(`
    SELECT status, evidence_artifact_id
      FROM strategy_redundancy_artifacts_v1
     WHERE as_of_date=?
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(businessDate).first<{ status: string; evidence_artifact_id: string | null }>()
  if (!similarity?.evidence_artifact_id || !['pass', 'pending_maturity', 'fail'].includes(String(similarity.status))) {
    throw new Error(`evening_chain_similarity_artifact_incomplete:${businessDate}`)
  }

  const sector = await marketDb.prepare(`
    SELECT COUNT(*) sector_rows,
           SUM(CASE
             WHEN stock_count IS NOT NULL AND stock_count>0
              AND up_count IS NOT NULL
              AND turnover_value IS NOT NULL
              AND turnover_share IS NOT NULL
              AND turnover_share_delta IS NOT NULL
             THEN 1 ELSE 0 END
           ) breadth_rows
      FROM sector_flow
     WHERE date=? AND pit_lineage_version='sector-flow-pit-v1'
  `).bind(businessDate).first<any>()
  const sectorRows = Number(sector?.sector_rows ?? 0)
  const sectorBreadthRows = Number(sector?.breadth_rows ?? 0)
  if (options.requireSectorBreadth !== false && (sectorRows <= 0 || sectorBreadthRows !== sectorRows)) {
    throw new Error(`evening_chain_sector_breadth_incomplete:${sectorBreadthRows}/${sectorRows}`)
  }

  const matureSignalDate = await resolveExpectedMatureSignalDate(env, businessDate)
  let matureReferenceRows = 0
  let priceHorizonRows = 0
  let priceHorizonUnavailableRows = 0
  let canonicalLabelRows = 0
  let canonicalUnavailableRows = 0
  if (matureSignalDate) {
    const matureHead = await opsDb.prepare(`
      SELECT run_id
        FROM canonical_run_heads
       WHERE logical_run_key=?
       LIMIT 1
    `).bind(
      `screener:${matureSignalDate}:TW:production:market_screener`,
    ).first<{ run_id: string | null }>()
    const matureProducerRunId = String(matureHead?.run_id ?? '').trim()
    if (!matureProducerRunId) {
      throw new Error(`evening_chain_mature_canonical_head_missing:${matureSignalDate}`)
    }
    const matureMatrix = await learningDb.prepare(`
      SELECT reference_candidate_count, expected_cell_count, persisted_cell_count,
             labeler_version, reference_contract_version,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=mr.producer_run_id
                 AND m.labeler_version=mr.labeler_version
                 AND m.reference_contract_version=mr.reference_contract_version) matrix_rows,
             (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r
               WHERE r.signal_date=mr.signal_date AND r.producer_run_id=mr.producer_run_id
                 AND r.hard_gate_passed=1
                 AND r.strategy_labeler_version=mr.labeler_version
                 AND r.feature_contract_version=mr.reference_contract_version) reference_contract_rows
        FROM strategy_label_matrix_runs_v4 mr
       WHERE signal_date=? AND producer_run_id=? AND status='ready'
         AND (
           (reference_contract_version=? AND labeler_version IN (?, ?))
           OR
           (reference_contract_version=? AND labeler_version IN (?, ?))
         )
         AND NOT EXISTS (
           SELECT 1 FROM strategy_label_matrix_v4 m
            WHERE m.producer_run_id=mr.producer_run_id
              AND m.labeler_version<>mr.labeler_version
         )
       LIMIT 1
    `).bind(
      matureSignalDate,
      matureProducerRunId,
      SELECTION_REFERENCE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
      SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
    ).first<any>()
    const matureReferenceContractVersion = String(matureMatrix?.reference_contract_version ?? '')
    if (
      Number(matureMatrix?.reference_candidate_count ?? 0) <= 0
      || Number(matureMatrix?.expected_cell_count ?? 0) <= 0
      || Number(matureMatrix?.persisted_cell_count ?? 0) !== Number(matureMatrix?.expected_cell_count ?? 0)
      || Number(matureMatrix?.matrix_rows ?? 0) !== Number(matureMatrix?.expected_cell_count ?? 0)
      || Number(matureMatrix?.reference_contract_rows ?? 0) !== Number(matureMatrix?.reference_candidate_count ?? 0)
    ) {
      throw new Error(`evening_chain_mature_strategy_matrix_incomplete:${matureSignalDate}`)
    }
    const coverage = await learningDb.prepare(`
      SELECT
        COUNT(*) reference_rows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM price_horizon_labels_v1 p
           WHERE p.price_date=r.signal_date AND p.stock_id=r.stock_id
             AND p.projection_version=?
        ) THEN 1 ELSE 0 END) horizon_rows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM price_horizon_label_rejections_v1 p
           WHERE p.price_date=r.signal_date AND p.stock_id=r.stock_id
             AND p.projection_version=?
        ) THEN 1 ELSE 0 END) horizon_unavailable_rows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM canonical_selection_labels_v4 l
           WHERE l.signal_date=r.signal_date AND l.symbol=r.symbol
             AND l.producer_run_id=r.producer_run_id
             AND l.label_schema_version=?
             AND l.reference_contract_version=?
             AND l.adjustment_source=?
        ) THEN 1 ELSE 0 END) label_rows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM canonical_selection_label_rejections_v4 x
           WHERE x.signal_date=r.signal_date AND x.symbol=r.symbol
             AND x.producer_run_id=r.producer_run_id
        ) THEN 1 ELSE 0 END) label_unavailable_rows
        FROM selection_reference_snapshots_v1 r
       WHERE r.signal_date=? AND r.hard_gate_passed=1
         AND r.feature_contract_version=?
         AND r.producer_run_id=?
         AND r.strategy_labeler_version=?
    `).bind(
      PRICE_HORIZON_PROJECTION_VERSION,
      PRICE_HORIZON_PROJECTION_VERSION,
      CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,
      matureReferenceContractVersion,
      CANONICAL_SELECTION_ADJUSTMENT_SOURCE,
      matureSignalDate,
      matureReferenceContractVersion,
      matureProducerRunId,
      String(matureMatrix?.labeler_version ?? ''),
    ).first<any>()
    matureReferenceRows = Number(coverage?.reference_rows ?? 0)
    priceHorizonRows = Number(coverage?.horizon_rows ?? 0)
    priceHorizonUnavailableRows = Number(coverage?.horizon_unavailable_rows ?? 0)
    canonicalLabelRows = Number(coverage?.label_rows ?? 0)
    canonicalUnavailableRows = Number(coverage?.label_unavailable_rows ?? 0)
    const projection = await opsDb.prepare(`
      SELECT status, candidate_count, materialized_count, rejected_count
        FROM price_horizon_projection_status
       WHERE signal_date=? AND projection_version=?
    `).bind(matureSignalDate, PRICE_HORIZON_PROJECTION_VERSION).first<any>()
    const projectionMaterialized = Number(projection?.materialized_count ?? 0)
    const projectionRejected = Number(projection?.rejected_count ?? 0)
    const projectionCandidates = Number(projection?.candidate_count ?? 0)
    const projectionCoverageComplete = ['success', 'incomplete'].includes(String(projection?.status ?? ''))
      && projectionCandidates === matureReferenceRows
      && projectionMaterialized === priceHorizonRows
      && projectionRejected === priceHorizonUnavailableRows
      && projectionMaterialized + projectionRejected === projectionCandidates
    if (
      matureReferenceRows <= 0
      || !projectionCoverageComplete
      || priceHorizonRows + priceHorizonUnavailableRows !== matureReferenceRows
      || canonicalLabelRows + canonicalUnavailableRows !== matureReferenceRows
    ) {
      throw new Error(
        `evening_chain_mature_evidence_incomplete:${matureSignalDate}:reference=${matureReferenceRows}`
        + `:horizon=${priceHorizonRows}:horizon_unavailable=${priceHorizonUnavailableRows}`
        + `:labels=${canonicalLabelRows}:label_unavailable=${canonicalUnavailableRows}`
        + `:projection=${projection?.status ?? 'missing'}`,
      )
    }
  }

  const matureBacklog = await inspectMatureSelectionEvidenceGaps(env, businessDate)
  const recoverableBacklog = matureBacklog.gaps.filter(isMatureSelectionEvidenceGapRecoverable)
  if (recoverableBacklog.length > 0) {
    throw new Error(
      `evening_chain_mature_evidence_backlog:${recoverableBacklog.map((gap) => (
        `${gap.signalDate}:${gap.blockers.join('|')}`
      )).join(',')}`,
    )
  }

  return {
    businessDate,
    referenceRows,
    referenceIdentityRows,
    referenceArtifactRows,
    decisionReconciledRows,
    referenceProjectionRows,
    matrixRows,
    expectedMatrixRows,
    matchedMatrixRows,
    thresholdEvidenceRows,
    challengerProjectionRows,
    projectedThresholdRows,
    similarityArtifactStatus: String(similarity.status),
    sectorRows,
    sectorBreadthRows,
    matureSignalDate,
    matureReferenceRows,
    priceHorizonRows,
    priceHorizonUnavailableRows,
    canonicalLabelRows,
    canonicalUnavailableRows,
    matureBacklogDates: recoverableBacklog.map((gap) => gap.signalDate),
    matureBlockedDates: matureBacklog.gaps.filter((gap) => !isMatureSelectionEvidenceGapRecoverable(gap)).map((gap) => gap.signalDate),
  }
}

export function summarizeEveningChainEvidenceClosure(audit: EveningChainEvidenceClosure): string {
  return [
    `reference_identity=${audit.referenceIdentityRows}/${audit.referenceRows}`,
    `strategy_matrix=${audit.matrixRows}/${audit.expectedMatrixRows}`,
    `threshold_margin=${audit.thresholdEvidenceRows}/${audit.matchedMatrixRows}`,
    `threshold_projection=${audit.projectedThresholdRows}/${audit.matchedMatrixRows}:matrix=${audit.challengerProjectionRows}/${audit.expectedMatrixRows}:reference=${audit.referenceProjectionRows}/${audit.referenceRows}`,
    `similarity_artifact=${audit.similarityArtifactStatus}`,
    `sector_breadth=${audit.sectorBreadthRows}/${audit.sectorRows}`,
    `mature_date=${audit.matureSignalDate ?? 'none'}`,
    `price_horizon=${audit.priceHorizonRows}+${audit.priceHorizonUnavailableRows}/${audit.matureReferenceRows}`,
    `canonical_labels=${audit.canonicalLabelRows}+${audit.canonicalUnavailableRows}/${audit.matureReferenceRows}`,
    `mature_blocked=${audit.matureBlockedDates.join(',') || 'none'}`,
    `mature_backlog=${audit.matureBacklogDates.join(',') || 'none'}`,
  ].join(' ')
}
