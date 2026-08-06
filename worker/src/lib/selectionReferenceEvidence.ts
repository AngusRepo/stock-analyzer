import {
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategySpec,
} from './strategySpec'

export const SELECTION_REFERENCE_CONTRACT_VERSION = 'selection-reference-snapshot-v3'
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
  strategy_affinity_version?: string | null
  strategy_challenger_affinity_version?: string | null
  strategy_router_version?: string | null
  strategy_router_score?: number | null
  strategy_challenger_route_version?: string | null
  strategy_challenger_route_score?: number | null
  strategy_router_decision?: string | null
  strategy_router_reason?: string | null
  strategy_pool_ids?: string[]
  strategy_affinity_vector?: Record<string, number>
  strategy_challenger_affinity_vector?: Record<string, number>
  strategy_match_strength_vector?: Record<string, number>
  strategy_threshold_margin_vector?: Record<string, number>
  strategy_affinity_evidence_count_vector?: Record<string, number>
  strategy_weak_label_vector?: Record<string, number>
  strategy_hit_vector?: Record<string, number>
  strategy_position_weight_vector?: Record<string, number>
  strategy_challenger_position_weight_vector?: Record<string, number>
  strategy_overlap_vector?: Record<string, number>
  strategy_evaluable_vector?: Record<string, number>
  strategy_unavailable_reason_vector?: Record<string, string | null>
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
  strategy_affinity_version: string | null
  strategy_router_version: string | null
  strategy_router_score: number | null
  strategy_challenger_affinity_version: string | null
  strategy_challenger_route_version: string | null
  strategy_challenger_route_score: number | null
  strategy_registry_checksum: string
}

async function resolveReferenceStockIds(
  identityDb: D1Database,
  references: SelectionReferenceRowV1[],
): Promise<Map<string, number>> {
  const symbols = [...new Set(references.map((row) => clean(row.symbol)).filter(Boolean))]
  const stockIds = new Map<string, number>()
  for (let offset = 0; offset < symbols.length; offset += 80) {
    const chunk = symbols.slice(offset, offset + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const result = await identityDb.prepare(`
      SELECT id, symbol
        FROM stocks
       WHERE symbol IN (${placeholders})
    `).bind(...chunk).all<{ id: number; symbol: string }>()
    for (const row of result.results ?? []) {
      const symbol = clean(row.symbol)
      const stockId = Number(row.id)
      if (symbol && Number.isInteger(stockId) && stockId > 0) stockIds.set(symbol, stockId)
    }
  }
  const missing = symbols.filter((symbol) => !stockIds.has(symbol))
  if (missing.length) {
    throw new Error(
      `selection_reference_stock_identity_incomplete:${stockIds.size}/${symbols.length}:missing=${missing.slice(0, 12).join(',')}`,
    )
  }
  return stockIds
}

async function reconcileReferenceStockIds(
  db: D1Database,
  producerRunId: string,
  references: SelectionReferenceRowV1[],
  stockIds: Map<string, number>,
): Promise<void> {
  const existing = await db.prepare(`
    SELECT symbol, stock_id
      FROM selection_reference_snapshots_v1
     WHERE producer_run_id=?
  `).bind(producerRunId).all<{ symbol: string; stock_id: number | null }>()
  for (const row of existing.results ?? []) {
    const expected = stockIds.get(clean(row.symbol))
    const actual = Number(row.stock_id)
    if (expected && Number.isInteger(actual) && actual > 0 && actual !== expected) {
      throw new Error(`selection_reference_stock_identity_conflict:${row.symbol}:${actual}/${expected}`)
    }
  }
  const statements = references.map((row) => db.prepare(`
    UPDATE selection_reference_snapshots_v1
       SET stock_id=?
     WHERE signal_date=? AND symbol=? AND producer_run_id=? AND stock_id IS NULL
  `).bind(stockIds.get(clean(row.symbol)), row.signal_date, row.symbol, producerRunId))
  for (let offset = 0; offset < statements.length; offset += 200) {
    await db.batch(statements.slice(offset, offset + 200))
  }
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
  affinity_version: string | null
  match_strength: number
  threshold_margin: number
  affinity_evidence_count: number
  position_weight: number
  challenger_affinity: number
  challenger_affinity_version: string | null
  challenger_position_weight: number
  overlap: number
  evaluable: number
  unavailable_reason: string | null
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
      strategy_affinity_version: clean(candidate.strategy_affinity_version) || null,
      strategy_router_version: clean(candidate.strategy_router_version) || null,
      strategy_router_score: Number.isFinite(Number(candidate.strategy_router_score)) ? Number(candidate.strategy_router_score) : null,
      strategy_challenger_affinity_version: clean(candidate.strategy_challenger_affinity_version) || null,
      strategy_challenger_route_version: clean(candidate.strategy_challenger_route_version) || null,
      strategy_challenger_route_score: Number.isFinite(Number(candidate.strategy_challenger_route_score)) ? Number(candidate.strategy_challenger_route_score) : null,
      strategy_registry_checksum: input.strategyRegistryChecksum,
    })

    for (const spec of specs) {
      const owner = spec.status === 'active'
        && spec.ownerType === 'strategy'
        && spec.promotionStatus === 'production'
      const evaluable = finite(candidate.strategy_evaluable_vector?.[spec.id], 0) > 0 ? 1 : 0
      const unavailableReason = clean(candidate.strategy_unavailable_reason_vector?.[spec.id])
        || (evaluable ? null : 'strategy_evaluability_missing')
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
        affinity_version: clean(candidate.strategy_affinity_version) || null,
        match_strength: finite(candidate.strategy_match_strength_vector?.[spec.id]),
        threshold_margin: finite(candidate.strategy_threshold_margin_vector?.[spec.id]),
        affinity_evidence_count: finite(candidate.strategy_affinity_evidence_count_vector?.[spec.id]),
        position_weight: finite(candidate.strategy_position_weight_vector?.[spec.id]),
        challenger_affinity: finite(candidate.strategy_challenger_affinity_vector?.[spec.id]),
        challenger_affinity_version: clean(candidate.strategy_challenger_affinity_version) || null,
        challenger_position_weight: finite(candidate.strategy_challenger_position_weight_vector?.[spec.id]),
        overlap: finite(candidate.strategy_overlap_vector?.[spec.id]),
        evaluable,
        unavailable_reason: unavailableReason,
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
       AND r.strategy_labeled=1
       AND r.strategy_matrix_status='ready'
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
    const evOwnerAvailable = expectedReturnOwner === 'allocator_ev_fusion'
    const fusionEvidence = parseObject(allocation?.allocator_ev_fusion)
    const l4Evidence = parseObject(allocation?.l4_alpha_ev)
      ?? parseObject(fusionEvidence?.l4_alpha_ev)
    const l4FeatureAvailable = Boolean(
      l4Evidence && ['loaded', 'verified'].includes(clean(l4Evidence.status).toLowerCase()))
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
      l4FeatureAvailable ? 1 : 0,
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
  identityDb: D1Database = db,
): Promise<{ referenceRows: number; matrixRows: number }> {
  const expectedCells = input.references.length * input.strategyCount
  if (input.matrix.length !== expectedCells) {
    throw new Error(`strategy_label_matrix_expected_cells_mismatch:${input.matrix.length}/${expectedCells}`)
  }
  const stockIds = await resolveReferenceStockIds(identityDb, input.references)
  const existing = await db.prepare(`
    SELECT status, reference_candidate_count, strategy_count, expected_cell_count,
           persisted_cell_count, strategy_registry_checksum, labeler_version, reference_contract_version
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
      && clean(existing.reference_contract_version) === SELECTION_REFERENCE_CONTRACT_VERSION
    if (!same) throw new Error('strategy_label_matrix_immutable_run_conflict')
    await reconcileReferenceStockIds(db, input.producerRunId, input.references, stockIds)
    const identityCoverage = await db.prepare(`
      SELECT COUNT(*) row_count,
             SUM(CASE WHEN stock_id IS NOT NULL THEN 1 ELSE 0 END) identity_count
        FROM selection_reference_snapshots_v1
       WHERE producer_run_id=?
    `).bind(input.producerRunId).first<{ row_count: number; identity_count: number }>()
    if (
      Number(identityCoverage?.row_count ?? 0) !== input.references.length
      || Number(identityCoverage?.identity_count ?? 0) !== input.references.length
    ) {
      throw new Error(
        `selection_reference_stock_identity_coverage_mismatch:${identityCoverage?.identity_count ?? 0}/${input.references.length}`,
      )
    }
    return { referenceRows: input.references.length, matrixRows: expectedCells }
  }

  await db.prepare(`
    INSERT INTO strategy_label_matrix_runs_v4 (
      producer_run_id, signal_date, status, reference_candidate_count,
      strategy_count, expected_cell_count, persisted_cell_count,
      strategy_registry_checksum, labeler_version, reference_contract_version
    ) VALUES (?, ?, 'writing', ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(producer_run_id) DO UPDATE SET
      signal_date=excluded.signal_date,
      status='writing',
      reference_candidate_count=excluded.reference_candidate_count,
      strategy_count=excluded.strategy_count,
      expected_cell_count=excluded.expected_cell_count,
      persisted_cell_count=0,
      strategy_registry_checksum=excluded.strategy_registry_checksum,
      labeler_version=excluded.labeler_version,
      reference_contract_version=excluded.reference_contract_version,
      error_code=NULL,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    input.producerRunId,
    input.signalDate,
    input.references.length,
    input.strategyCount,
    expectedCells,
    input.strategyRegistryChecksum,
    input.labelerVersion,
    SELECTION_REFERENCE_CONTRACT_VERSION,
  ).run()

  try {
    const referenceStatements = input.references.map((row) => db.prepare(`
      INSERT INTO selection_reference_snapshots_v1 (
        signal_date, symbol, producer_run_id, stock_id, name, market_segment, sector,
        hard_gate_passed, hard_gate_reason, feature_available, feature_rejection_reason, strategy_labeled,
        strategy_selected, ml_selected, l4_selected, ev_owner_available, final_signal,
        selection_stage, rejection_reason, selection_propensity, score_v2, score_components,
        allocation_selected, decision_evidence_reconciled_at,
        strategy_labeler_version, strategy_affinity_version, strategy_router_version, strategy_router_score,
        strategy_challenger_affinity_version, strategy_challenger_route_version, strategy_challenger_route_score,
        strategy_registry_checksum, feature_contract_version, evidence_artifact_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'hard_filters_passed', ?, ?, 1, ?, 0, 0, 0, NULL,
                ?, ?, 1.0, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signal_date, symbol, producer_run_id) DO UPDATE SET
        stock_id=CASE
          WHEN selection_reference_snapshots_v1.stock_id IS NULL THEN excluded.stock_id
          ELSE selection_reference_snapshots_v1.stock_id
        END,
        strategy_labeled=1,
        strategy_selected=excluded.strategy_selected,
        strategy_labeler_version=excluded.strategy_labeler_version,
        strategy_affinity_version=excluded.strategy_affinity_version,
        strategy_challenger_affinity_version=excluded.strategy_challenger_affinity_version,
        strategy_router_version=COALESCE(
          excluded.strategy_router_version,
          selection_reference_snapshots_v1.strategy_router_version
        ),
        strategy_router_score=COALESCE(
          excluded.strategy_router_score,
          selection_reference_snapshots_v1.strategy_router_score
        ),
        strategy_challenger_route_version=COALESCE(
          excluded.strategy_challenger_route_version,
          selection_reference_snapshots_v1.strategy_challenger_route_version
        ),
        strategy_challenger_route_score=COALESCE(
          excluded.strategy_challenger_route_score,
          selection_reference_snapshots_v1.strategy_challenger_route_score
        ),
        strategy_registry_checksum=excluded.strategy_registry_checksum,
        feature_contract_version=excluded.feature_contract_version,
        evidence_artifact_id=excluded.evidence_artifact_id
    `).bind(
      row.signal_date, row.symbol, row.producer_run_id, stockIds.get(clean(row.symbol)), row.name,
      row.market_segment, row.sector, row.feature_available, row.feature_rejection_reason,
      row.strategy_selected, row.selection_stage, row.rejection_reason, row.score_v2,
      row.score_components, row.strategy_labeler_version, row.strategy_affinity_version,
      row.strategy_router_version, row.strategy_router_score,
      row.strategy_challenger_affinity_version, row.strategy_challenger_route_version,
      row.strategy_challenger_route_score, row.strategy_registry_checksum, SELECTION_REFERENCE_CONTRACT_VERSION,
      input.evidenceArtifactId,
    ))
    for (let offset = 0; offset < referenceStatements.length; offset += 200) {
      await db.batch(referenceStatements.slice(offset, offset + 200))
    }

    const matrixStatements = input.matrix.map((row) => db.prepare(`
      INSERT OR IGNORE INTO strategy_label_matrix_v4 (
        signal_date, symbol, producer_run_id, strategy_id, strategy_version,
        strategy_status, alpha_bucket, family_id, production_owner,
        strategy_hit, weak_label, affinity, affinity_version, match_strength,
        threshold_margin, affinity_evidence_count, position_weight,
        challenger_affinity, challenger_affinity_version, challenger_position_weight, overlap,
        evaluable, unavailable_reason, label_reason, labeler_version,
        strategy_registry_checksum, reference_contract_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).bind(
      row.signal_date, row.symbol, row.producer_run_id, row.strategy_id,
      row.strategy_version, row.strategy_status, row.alpha_bucket, row.family_id,
      row.production_owner, row.strategy_hit, row.weak_label, row.affinity,
      row.affinity_version, row.match_strength, row.threshold_margin, row.affinity_evidence_count,
      row.position_weight, row.challenger_affinity, row.challenger_affinity_version,
      row.challenger_position_weight,
      row.overlap, row.evaluable, row.unavailable_reason, row.labeler_version,
      row.strategy_registry_checksum, SELECTION_REFERENCE_CONTRACT_VERSION,
    ))
    for (let offset = 0; offset < matrixStatements.length; offset += 250) {
      await db.batch(matrixStatements.slice(offset, offset + 250))
    }

    const counts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM selection_reference_snapshots_v1 WHERE producer_run_id = ? AND hard_gate_passed = 1) reference_rows,
        (SELECT COUNT(*) FROM selection_reference_snapshots_v1 WHERE producer_run_id = ? AND hard_gate_passed = 1 AND stock_id IS NOT NULL) identity_rows,
        (SELECT COUNT(*) FROM strategy_label_matrix_v4 WHERE producer_run_id = ?) matrix_rows
    `).bind(input.producerRunId, input.producerRunId, input.producerRunId).first<any>()
    const referenceRows = Number(counts?.reference_rows ?? 0)
    const identityRows = Number(counts?.identity_rows ?? 0)
    const matrixRows = Number(counts?.matrix_rows ?? 0)
    if (referenceRows !== input.references.length || identityRows !== referenceRows || matrixRows !== expectedCells) {
      throw new Error(
        `strategy_label_matrix_persisted_coverage_mismatch:${referenceRows}/${input.references.length}:identity=${identityRows}/${referenceRows}:${matrixRows}/${expectedCells}`,
      )
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
