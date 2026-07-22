import {
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategySpec,
} from './strategySpec'

export const SELECTION_REFERENCE_CONTRACT_VERSION = 'selection-reference-snapshot-v2'
export const STRATEGY_LABEL_MATRIX_VERSION = 'strategy-label-matrix-v4'

export interface SelectionEvidenceCandidate {
  symbol: string
  name?: string | null
  sector?: string | null
  industry?: string | null
  market_segment?: string | null
  score?: number | null
  score_components?: unknown
  strategy_labeler_version?: string | null
  strategy_router_version?: string | null
  strategy_router_decision?: string | null
  strategy_router_reason?: string | null
  strategy_pool_ids?: string[]
  strategy_affinity_vector?: Record<string, number>
  strategy_weak_label_vector?: Record<string, number>
  strategy_hit_vector?: Record<string, number>
  strategy_position_weight_vector?: Record<string, number>
  strategy_overlap_vector?: Record<string, number>
}

export interface SelectionReferenceRowV1 {
  signal_date: string
  symbol: string
  producer_run_id: string
  name: string | null
  market_segment: string | null
  sector: string | null
  strategy_selected: number
  selection_stage: string
  rejection_reason: string | null
  score_v2: number | null
  score_components: string | null
  feature_available: number
  feature_rejection_reason: string | null
  strategy_labeler_version: string | null
  strategy_router_version: string | null
  strategy_registry_checksum: string
}

export interface StrategyLabelMatrixRowV4 {
  signal_date: string
  symbol: string
  producer_run_id: string
  strategy_id: string
  strategy_version: string
  strategy_status: string
  alpha_bucket: string
  family_id: string
  production_owner: number
  strategy_hit: number
  weak_label: number
  affinity: number
  position_weight: number
  overlap: number
  labeler_version: string
  strategy_registry_checksum: string
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function canonicalScoreV2Json(value: unknown): string | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || String((parsed as any).version ?? '') !== 'score_v2') return null
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function eligibleSpecs(specs: StrategySpec[]): StrategySpec[] {
  return specs
    .filter((spec) => spec.status !== 'retired')
    .map(normalizeStrategySpecGovernance)
    .filter((spec) => validateStrategySpec(spec).ok)
    .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version))
}

export function strategyRegistryFingerprintPayload(specs: StrategySpec[]): unknown[] {
  return eligibleSpecs(specs).map((spec) => ({
    id: spec.id,
    version: spec.version,
    status: spec.status,
    alpha_bucket: spec.alphaBucket,
    family_id: spec.familyId,
    owner_type: spec.ownerType,
    promotion_status: spec.promotionStatus,
    supported_regimes: spec.supportedRegimes,
    thresholds: spec.thresholds,
    candidate_policy: spec.candidatePolicy,
  }))
}

export function buildSelectionEvidenceV4(input: {
  signalDate: string
  producerRunId: string
  candidates: SelectionEvidenceCandidate[]
  specs: StrategySpec[]
  strategyRegistryChecksum: string
}): {
  references: SelectionReferenceRowV1[]
  matrix: StrategyLabelMatrixRowV4[]
  strategyCount: number
} {
  const specs = eligibleSpecs(input.specs)
  const references: SelectionReferenceRowV1[] = []
  const matrix: StrategyLabelMatrixRowV4[] = []
  const seen = new Set<string>()

  for (const candidate of input.candidates) {
    const symbol = clean(candidate.symbol)
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    const selected = clean(candidate.strategy_router_decision) === 'ml_slate'
    const scoreComponents = canonicalScoreV2Json(candidate.score_components)
    const labelerVersion = clean(candidate.strategy_labeler_version)
    if (!labelerVersion) {
      throw new Error(`strategy_labeler_version_missing:${symbol}`)
    }
    references.push({
      signal_date: input.signalDate,
      symbol,
      producer_run_id: input.producerRunId,
      name: clean(candidate.name) || null,
      market_segment: clean(candidate.market_segment) || null,
      sector: clean(candidate.industry ?? candidate.sector) || null,
      strategy_selected: selected ? 1 : 0,
      selection_stage: selected ? 'l15_router_selected' : 'l1_labeled_observe',
      rejection_reason: selected ? null : clean(candidate.strategy_router_reason) || 'not_selected_by_l15_router',
      score_v2: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : null,
      score_components: scoreComponents,
      feature_available: scoreComponents ? 1 : 0,
      feature_rejection_reason: scoreComponents ? null : 'score_v2_components_missing_or_invalid',
      strategy_labeler_version: labelerVersion,
      strategy_router_version: clean(candidate.strategy_router_version) || null,
      strategy_registry_checksum: input.strategyRegistryChecksum,
    })

    for (const spec of specs) {
      const owner = spec.status === 'active'
        && spec.ownerType === 'strategy'
        && spec.promotionStatus === 'production'
      matrix.push({
        signal_date: input.signalDate,
        symbol,
        producer_run_id: input.producerRunId,
        strategy_id: spec.id,
        strategy_version: spec.version,
        strategy_status: spec.status,
        alpha_bucket: spec.alphaBucket,
        family_id: clean(spec.familyId) || 'UNKNOWN',
        production_owner: owner ? 1 : 0,
        strategy_hit: finite(candidate.strategy_hit_vector?.[spec.id]) > 0 ? 1 : 0,
        weak_label: finite(candidate.strategy_weak_label_vector?.[spec.id]),
        affinity: finite(candidate.strategy_affinity_vector?.[spec.id]),
        position_weight: finite(candidate.strategy_position_weight_vector?.[spec.id]),
        overlap: finite(candidate.strategy_overlap_vector?.[spec.id]),
        labeler_version: labelerVersion,
        strategy_registry_checksum: input.strategyRegistryChecksum,
      })
    }
  }

  const expectedCells = references.length * specs.length
  if (matrix.length !== expectedCells) {
    throw new Error(`strategy_label_matrix_incomplete:${matrix.length}/${expectedCells}`)
  }
  return { references, matrix, strategyCount: specs.length }
}

export async function reconcileSelectionDecisionEvidenceV4(
  db: D1Database,
  signalDate: string,
): Promise<{ referenceRows: number; mlEvaluatedRows: number; evOwnerRows: number; allocationSelectedRows: number; finalSignalRows: number }> {
  const result = await db.prepare(`
    SELECT r.symbol, r.producer_run_id, r.rejection_reason,
           dr.ml_score, dr.ml_vote_summary, dr.alpha_allocation,
           dr.signal, dr.score_components
      FROM selection_reference_snapshots_v1 r
      LEFT JOIN daily_recommendations dr
        ON dr.date=r.signal_date AND dr.symbol=r.symbol
     WHERE r.signal_date=?
       AND EXISTS (
         SELECT 1 FROM canonical_run_heads h
          WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
            AND h.run_id=r.producer_run_id
       )
     ORDER BY r.symbol
  `).bind(signalDate).all<{
    symbol: string
    producer_run_id: string
    rejection_reason?: string | null
    ml_score?: number | string | null
    ml_vote_summary?: string | null
    alpha_allocation?: string | null
    signal?: string | null
    score_components?: string | null
  }>()
  const rows = result.results ?? []
  let mlEvaluatedRows = 0
  let evOwnerRows = 0
  let allocationSelectedRows = 0
  let finalSignalRows = 0
  const statements = rows.map((row) => {
    const allocation = parseObject(row.alpha_allocation)
    const finalSignal = clean(row.signal).toUpperCase() || null
    const mlEvidence = parseObject(row.ml_vote_summary)
    const mlEvaluated = Boolean(finalSignal && mlEvidence && Number.isFinite(Number(row.ml_score)))
    const expectedReturnOwner = clean(allocation?.expected_return_owner)
    const l4OwnerAvailable = ['l4_alpha_ev', 'allocator_ev_fusion'].includes(expectedReturnOwner)
    const evOwnerAvailable = l4OwnerAvailable || expectedReturnOwner === 's12_trade_ev'
    const allocationSelected = allocation?.selected === true || Number(allocation?.selected) === 1
    if (mlEvaluated) mlEvaluatedRows++
    if (evOwnerAvailable) evOwnerRows++
    if (allocationSelected) allocationSelectedRows++
    if (finalSignal) finalSignalRows++
    const selectionStage = allocationSelected
      ? 'allocator_selected'
      : evOwnerAvailable
        ? 'allocator_not_selected'
        : mlEvaluated
          ? 'ml_evaluated_waiting_expected_return'
          : 'l1_labeled_observe'
    const rejectionReason = allocationSelected
      ? null
      : evOwnerAvailable
        ? (finalSignal === 'HOLD' ? 'final_signal_hold' : 'allocator_not_selected')
        : mlEvaluated
          ? 'expected_return_owner_unavailable'
          : clean(row.rejection_reason) || 'not_selected_for_ml_evaluation'
    return db.prepare(`
      UPDATE selection_reference_snapshots_v1
         SET ml_selected=?, l4_selected=?, ev_owner_available=?, allocation_selected=?, final_signal=?,
             selection_stage=?, rejection_reason=?,
             score_components=COALESCE(score_components, ?),
             decision_evidence_reconciled_at=CURRENT_TIMESTAMP
       WHERE signal_date=? AND symbol=? AND producer_run_id=?
    `).bind(
      mlEvaluated ? 1 : 0,
      l4OwnerAvailable ? 1 : 0,
      evOwnerAvailable ? 1 : 0,
      allocationSelected ? 1 : 0,
      finalSignal,
      selectionStage,
      rejectionReason,
      canonicalScoreV2Json(row.score_components),
      signalDate,
      row.symbol,
      row.producer_run_id,
    )
  })
  for (let offset = 0; offset < statements.length; offset += 200) {
    await db.batch(statements.slice(offset, offset + 200))
  }
  return {
    referenceRows: rows.length,
    mlEvaluatedRows,
    evOwnerRows,
    allocationSelectedRows,
    finalSignalRows,
  }
}

export async function persistSelectionEvidenceV4(
  db: D1Database,
  input: {
    signalDate: string
    producerRunId: string
    references: SelectionReferenceRowV1[]
    matrix: StrategyLabelMatrixRowV4[]
    strategyCount: number
    strategyRegistryChecksum: string
    labelerVersion: string
    evidenceArtifactId: string
  },
): Promise<{ referenceRows: number; matrixRows: number }> {
  const expectedCells = input.references.length * input.strategyCount
  if (input.matrix.length !== expectedCells) {
    throw new Error(`strategy_label_matrix_expected_cells_mismatch:${input.matrix.length}/${expectedCells}`)
  }
  const existing = await db.prepare(`
    SELECT status, reference_candidate_count, strategy_count, expected_cell_count,
           persisted_cell_count, strategy_registry_checksum, labeler_version
      FROM strategy_label_matrix_runs_v4
     WHERE producer_run_id = ?
  `).bind(input.producerRunId).first<any>()
  if (existing?.status === 'ready') {
    const same = Number(existing.reference_candidate_count) === input.references.length
      && Number(existing.strategy_count) === input.strategyCount
      && Number(existing.expected_cell_count) === expectedCells
      && Number(existing.persisted_cell_count) === expectedCells
      && clean(existing.strategy_registry_checksum) === input.strategyRegistryChecksum
      && clean(existing.labeler_version) === input.labelerVersion
    if (!same) throw new Error('strategy_label_matrix_immutable_run_conflict')
    return { referenceRows: input.references.length, matrixRows: expectedCells }
  }

  await db.prepare(`
    INSERT INTO strategy_label_matrix_runs_v4 (
      producer_run_id, signal_date, status, reference_candidate_count,
      strategy_count, expected_cell_count, persisted_cell_count,
      strategy_registry_checksum, labeler_version
    ) VALUES (?, ?, 'writing', ?, ?, ?, 0, ?, ?)
    ON CONFLICT(producer_run_id) DO UPDATE SET
      status='writing', error_code=NULL, updated_at=CURRENT_TIMESTAMP
  `).bind(
    input.producerRunId,
    input.signalDate,
    input.references.length,
    input.strategyCount,
    expectedCells,
    input.strategyRegistryChecksum,
    input.labelerVersion,
  ).run()

  try {
    const referenceStatements = input.references.map((row) => db.prepare(`
      INSERT OR IGNORE INTO selection_reference_snapshots_v1 (
        signal_date, symbol, producer_run_id, name, market_segment, sector,
        hard_gate_passed, hard_gate_reason, feature_available, feature_rejection_reason, strategy_labeled,
        strategy_selected, ml_selected, l4_selected, ev_owner_available, final_signal,
        selection_stage, rejection_reason, selection_propensity, score_v2, score_components,
        allocation_selected, decision_evidence_reconciled_at,
        strategy_labeler_version, strategy_router_version,
        strategy_registry_checksum, feature_contract_version, evidence_artifact_id
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'hard_filters_passed', ?, ?, 1, ?, 0, 0, 0, NULL,
                ?, ?, 1.0, ?, ?, 0, NULL, ?, ?, ?, ?, ?)
    `).bind(
      row.signal_date, row.symbol, row.producer_run_id, row.name,
      row.market_segment, row.sector, row.feature_available, row.feature_rejection_reason,
      row.strategy_selected, row.selection_stage, row.rejection_reason, row.score_v2,
      row.score_components, row.strategy_labeler_version, row.strategy_router_version,
      row.strategy_registry_checksum, SELECTION_REFERENCE_CONTRACT_VERSION,
      input.evidenceArtifactId,
    ))
    for (let offset = 0; offset < referenceStatements.length; offset += 200) {
      await db.batch(referenceStatements.slice(offset, offset + 200))
    }

    const matrixStatements = input.matrix.map((row) => db.prepare(`
      INSERT OR IGNORE INTO strategy_label_matrix_v4 (
        signal_date, symbol, producer_run_id, strategy_id, strategy_version,
        strategy_status, alpha_bucket, family_id, production_owner,
        strategy_hit, weak_label, affinity, position_weight, overlap,
        label_reason, labeler_version, strategy_registry_checksum,
        reference_contract_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).bind(
      row.signal_date, row.symbol, row.producer_run_id, row.strategy_id,
      row.strategy_version, row.strategy_status, row.alpha_bucket, row.family_id,
      row.production_owner, row.strategy_hit, row.weak_label, row.affinity,
      row.position_weight, row.overlap, row.labeler_version,
      row.strategy_registry_checksum, SELECTION_REFERENCE_CONTRACT_VERSION,
    ))
    for (let offset = 0; offset < matrixStatements.length; offset += 250) {
      await db.batch(matrixStatements.slice(offset, offset + 250))
    }

    const counts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM selection_reference_snapshots_v1 WHERE producer_run_id = ?) reference_rows,
        (SELECT COUNT(*) FROM strategy_label_matrix_v4 WHERE producer_run_id = ?) matrix_rows
    `).bind(input.producerRunId, input.producerRunId).first<any>()
    const referenceRows = Number(counts?.reference_rows ?? 0)
    const matrixRows = Number(counts?.matrix_rows ?? 0)
    if (referenceRows !== input.references.length || matrixRows !== expectedCells) {
      throw new Error(`strategy_label_matrix_persisted_coverage_mismatch:${referenceRows}/${input.references.length}:${matrixRows}/${expectedCells}`)
    }
    await db.prepare(`
      UPDATE strategy_label_matrix_runs_v4
         SET status='ready', persisted_cell_count=?, updated_at=CURRENT_TIMESTAMP
       WHERE producer_run_id=? AND status='writing'
    `).bind(matrixRows, input.producerRunId).run()
    return { referenceRows, matrixRows }
  } catch (error) {
    await db.prepare(`
      UPDATE strategy_label_matrix_runs_v4
         SET status='failed', error_code=?, updated_at=CURRENT_TIMESTAMP
       WHERE producer_run_id=?
    `).bind(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), input.producerRunId).run().catch(() => {})
    throw error
  }
}
