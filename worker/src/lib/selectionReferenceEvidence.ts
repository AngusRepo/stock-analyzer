import {
  STRATEGY_FORMAL_LABELER_VERSIONS,
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategySpec,
} from './strategySpec'
import {
  classifyStrategyEvaluability,
  type StrategyEvaluabilityStatus,
} from './strategyEvaluability'
import { sha256Text } from './datasetSnapshots'

export const SELECTION_REFERENCE_CONTRACT_VERSION = 'selection-reference-snapshot-v4-regime-veto-evidence'
export const SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION = 'selection-reference-snapshot-v3'
export const SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS = [
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
] as const
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
  strategy_pre_regime_setup_hit_vector?: Record<string, number>
  strategy_regime_eligible_vector?: Record<string, number>
  strategy_formal_veto_reason_vector?: Record<string, string | null>
  strategy_counterfactual_affinity_vector?: Record<string, number>
  strategy_counterfactual_production_effect_vector?: Record<string, number>
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
  pre_regime_setup_hit: number
  regime_eligible: number
  formal_veto_reason: string | null
  counterfactual_affinity: number
  counterfactual_production_effect: 0
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
  evaluability_status: StrategyEvaluabilityStatus
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
  const labelerVersions = new Set<string>()

  for (const candidate of input.candidates) {
    const symbol = clean(candidate.symbol)
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    const selected = clean(candidate.strategy_router_decision) === 'ml_slate'
    const scoreComponents = canonicalScoreV2Json(candidate.score_components)
    const labelerVersion = clean(candidate.strategy_labeler_version)
    if (!STRATEGY_FORMAL_LABELER_VERSIONS.some((version) => version === labelerVersion)) {
      throw new Error(`strategy_labeler_version_nonformal:${symbol}:${labelerVersion || 'missing'}`)
    }
    labelerVersions.add(labelerVersion)
    if (labelerVersions.size > 1) throw new Error('strategy_labeler_version_mixed_run')
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
      const rawEvaluable = finite(candidate.strategy_evaluable_vector?.[spec.id], 0) > 0
      const rawUnavailableReason = clean(candidate.strategy_unavailable_reason_vector?.[spec.id])
        || (rawEvaluable ? '' : 'strategy_evaluability_missing')
      const classification = classifyStrategyEvaluability({
        spec, specValid: true, evaluable: rawEvaluable,
        unavailableReasons: rawUnavailableReason ? [rawUnavailableReason] : [],
      })
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
        pre_regime_setup_hit: finite(candidate.strategy_pre_regime_setup_hit_vector?.[spec.id]) > 0 ? 1 : 0,
        regime_eligible: finite(candidate.strategy_regime_eligible_vector?.[spec.id], 1) > 0 ? 1 : 0,
        formal_veto_reason: clean(candidate.strategy_formal_veto_reason_vector?.[spec.id]) || null,
        counterfactual_affinity: finite(candidate.strategy_counterfactual_affinity_vector?.[spec.id]),
        counterfactual_production_effect: 0,
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
        evaluable: classification.evaluable,
        evaluability_status: classification.status,
        unavailable_reason: classification.reason,
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

export const SELECTION_CHAIN_RECEIPT_VERSION = 'selection-chain-receipt-v1' as const

export interface SelectionChainReceiptV1 {
  version: typeof SELECTION_CHAIN_RECEIPT_VERSION
  stages: {
    l15_router_selected: boolean
    ml_eligible: boolean
    ml_evaluated: boolean
    l4_feature_available: boolean
    l4_production_eligible: boolean
    fusion_feature_available: boolean
    primary_expected_return_available: boolean
    allocator_selected: boolean
    has_buy_signal: boolean
    pending_buy_eligible: boolean
    pending_buy_candidate: boolean
  }
  owners: {
    expected_return_owner: string | null
    l4_status: string | null
    fusion_status: string | null
  }
  terminal: {
    selection_stage: string
    rejection_reason: string | null
  }
}

export interface SelectionDecisionEvidenceInputV1 {
  strategySelected?: unknown
  priorRejectionReason?: unknown
  mlScore?: unknown
  mlVoteSummary?: unknown
  alphaAllocation?: unknown
  signal?: unknown
  hasBuySignal?: unknown
  eligibleForMl?: unknown
  eligibleForPendingBuy?: unknown
}

function evidenceFlag(value: unknown): boolean {
  return value === true || Number(value) === 1
}

export function buildSelectionChainReceiptV1(input: SelectionDecisionEvidenceInputV1): SelectionChainReceiptV1 {
  const allocation = parseObject(input.alphaAllocation)
  const finalSignal = clean(input.signal).toUpperCase() || null
  const mlEvidence = parseObject(input.mlVoteSummary)
  const routeSelected = evidenceFlag(input.strategySelected)
  const mlEligible = evidenceFlag(input.eligibleForMl)
  const mlEvaluated = Boolean(finalSignal && mlEvidence && Number.isFinite(Number(input.mlScore)))
  const expectedReturnOwner = clean(allocation?.expected_return_owner) || null
  const evOwnerAvailable = expectedReturnOwner === 'allocator_ev_fusion'
  const fusionEvidence = parseObject(allocation?.allocator_ev_fusion)
  const l4Evidence = parseObject(allocation?.l4_alpha_ev)
    ?? parseObject(fusionEvidence?.l4_alpha_ev)
  const l4Status = clean(l4Evidence?.status).toLowerCase() || null
  const fusionStatus = clean(fusionEvidence?.status).toLowerCase() || null
  const l4FeatureAvailable = Boolean(l4Evidence && ['loaded', 'verified'].includes(l4Status ?? ''))
  const l4ProductionEligible = Boolean(
    l4Evidence
    && (l4Evidence.production_eligible === true || Number(l4Evidence.production_eligible) === 1),
  )
  const fusionFeatureAvailable = Boolean(
    fusionEvidence
    && !['unavailable', 'missing', 'blocked', 'error'].includes(fusionStatus ?? ''),
  )
  const primaryExpectedReturnAvailable = Boolean(
    evOwnerAvailable
    && (
      fusionEvidence?.primary_expected_return_allowed === true
      || Number(fusionEvidence?.primary_expected_return_allowed) === 1
      || (allocation?.expected_return != null && Number.isFinite(Number(allocation.expected_return)))
    ),
  )
  const allocationSelected = evidenceFlag(allocation?.selected)
  const hasBuySignal = evidenceFlag(input.hasBuySignal)
  const pendingBuyEligible = evidenceFlag(input.eligibleForPendingBuy)
  const pendingBuyCandidate = pendingBuyEligible && allocationSelected && hasBuySignal
  const selectionStage = pendingBuyCandidate
    ? 'pending_buy_candidate'
    : hasBuySignal
      ? 'buy_signal_blocked_before_pending_buy'
      : allocationSelected
        ? 'allocator_selected_no_buy_signal'
        : evOwnerAvailable
          ? 'allocator_not_selected'
          : mlEvaluated
            ? 'ml_evaluated_waiting_expected_return'
            : routeSelected
              ? 'l15_router_selected'
              : 'l1_labeled_observe'
  const rejectionReason = pendingBuyCandidate
    ? null
    : hasBuySignal && !pendingBuyEligible
      ? 'pending_buy_ineligible'
      : hasBuySignal && !allocationSelected
        ? 'buy_signal_without_allocator_selection'
        : allocationSelected
          ? (finalSignal === 'HOLD' ? 'final_signal_hold' : 'allocator_selected_without_buy_signal')
          : evOwnerAvailable
            ? 'allocator_not_selected'
            : mlEvaluated
              ? 'expected_return_owner_unavailable'
              : routeSelected
                ? 'route_selected_without_ml_evaluation'
                : clean(input.priorRejectionReason) || 'not_selected_by_l15_router'
  return {
    version: SELECTION_CHAIN_RECEIPT_VERSION,
    stages: {
      l15_router_selected: routeSelected,
      ml_eligible: mlEligible,
      ml_evaluated: mlEvaluated,
      l4_feature_available: l4FeatureAvailable,
      l4_production_eligible: l4ProductionEligible,
      fusion_feature_available: fusionFeatureAvailable,
      primary_expected_return_available: primaryExpectedReturnAvailable,
      allocator_selected: allocationSelected,
      has_buy_signal: hasBuySignal,
      pending_buy_eligible: pendingBuyEligible,
      pending_buy_candidate: pendingBuyCandidate,
    },
    owners: {
      expected_return_owner: expectedReturnOwner,
      l4_status: l4Status,
      fusion_status: fusionStatus,
    },
    terminal: {
      selection_stage: selectionStage,
      rejection_reason: rejectionReason,
    },
  }
}

export async function reconcileSelectionDecisionEvidenceV4(
  db: D1Database,
  signalDate: string,
  options: {
    identityDb?: D1Database
    canonicalProducerRunId?: string | null
  } = {},
): Promise<{
  referenceRows: number
  mlEvaluatedRows: number
  evOwnerRows: number
  allocationSelectedRows: number
  finalSignalRows: number
  pendingBuyCandidateRows: number
}> {
  type DecisionEvidenceRow = {
    symbol: string
    producer_run_id: string
    strategy_selected?: number | boolean | null
    rejection_reason?: string | null
    ml_score?: number | string | null
    ml_vote_summary?: string | null
    alpha_allocation?: string | null
    signal?: string | null
    has_buy_signal?: number | boolean | null
    eligible_for_ml?: number | boolean | null
    eligible_for_pending_buy?: number | boolean | null
    score_components?: string | null
  }

  let rows: DecisionEvidenceRow[]
  if (options.identityDb && options.canonicalProducerRunId) {
    const referenceResult = await db.prepare(`
      SELECT symbol, producer_run_id, strategy_selected, rejection_reason
        FROM selection_reference_snapshots_v1
       WHERE signal_date=?
         AND producer_run_id=?
         AND strategy_labeled=1
         AND strategy_matrix_status='ready'
       ORDER BY symbol
    `).bind(signalDate, options.canonicalProducerRunId).all<DecisionEvidenceRow>()
    const references = referenceResult.results ?? []
    const recommendationBySymbol = new Map<string, DecisionEvidenceRow>()
    const symbols = references.map((row) => clean(row.symbol)).filter(Boolean)
    for (let offset = 0; offset < symbols.length; offset += 80) {
      const chunk = symbols.slice(offset, offset + 80)
      const placeholders = chunk.map(() => '?').join(', ')
      const recommendationResult = await options.identityDb.prepare(`
        SELECT symbol, ml_score, ml_vote_summary, alpha_allocation, signal,
               has_buy_signal, eligible_for_ml, eligible_for_pending_buy, score_components
          FROM daily_recommendations
         WHERE date=?
           AND symbol IN (${placeholders})
      `).bind(signalDate, ...chunk).all<DecisionEvidenceRow>()
      for (const row of recommendationResult.results ?? []) {
        recommendationBySymbol.set(clean(row.symbol), row)
      }
    }
    rows = references.map((reference) => ({
      ...reference,
      ...recommendationBySymbol.get(clean(reference.symbol)),
      symbol: reference.symbol,
      producer_run_id: reference.producer_run_id,
      strategy_selected: reference.strategy_selected,
      rejection_reason: reference.rejection_reason,
    }))
  } else {
    const result = await db.prepare(`
      SELECT r.symbol, r.producer_run_id, r.strategy_selected, r.rejection_reason,
             dr.ml_score, dr.ml_vote_summary, dr.alpha_allocation,
             dr.signal, dr.has_buy_signal, dr.eligible_for_ml,
             dr.eligible_for_pending_buy, dr.score_components
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
    `).bind(signalDate).all<DecisionEvidenceRow>()
    rows = result.results ?? []
  }
  let mlEvaluatedRows = 0
  let evOwnerRows = 0
  let allocationSelectedRows = 0
  let finalSignalRows = 0
  let pendingBuyCandidateRows = 0
  const statements = rows.map((row) => {
    const receipt = buildSelectionChainReceiptV1({
      strategySelected: row.strategy_selected,
      priorRejectionReason: row.rejection_reason,
      mlScore: row.ml_score,
      mlVoteSummary: row.ml_vote_summary,
      alphaAllocation: row.alpha_allocation,
      signal: row.signal,
      hasBuySignal: row.has_buy_signal,
      eligibleForMl: row.eligible_for_ml,
      eligibleForPendingBuy: row.eligible_for_pending_buy,
    })
    if (receipt.stages.ml_evaluated) mlEvaluatedRows++
    if (receipt.owners.expected_return_owner === 'allocator_ev_fusion') evOwnerRows++
    if (receipt.stages.allocator_selected) allocationSelectedRows++
    if (clean(row.signal)) finalSignalRows++
    if (receipt.stages.pending_buy_candidate) pendingBuyCandidateRows++
    return db.prepare(`
      UPDATE selection_reference_snapshots_v1
         SET ml_evaluated=?, l4_feature_available=?, l4_production_eligible=?,
             fusion_feature_available=?, primary_expected_return_available=?,
             ev_owner_available=?, allocation_selected=?, final_signal=?,
             pending_buy_eligible=?, pending_buy_candidate=?,
             selection_stage=?, rejection_reason=?,
             selection_chain_contract_version=?, selection_chain_receipt_json=?,
             score_components=COALESCE(score_components, ?),
             decision_evidence_reconciled_at=CURRENT_TIMESTAMP
       WHERE signal_date=? AND symbol=? AND producer_run_id=?
    `).bind(
      receipt.stages.ml_evaluated ? 1 : 0,
      receipt.stages.l4_feature_available ? 1 : 0,
      receipt.stages.l4_production_eligible ? 1 : 0,
      receipt.stages.fusion_feature_available ? 1 : 0,
      receipt.stages.primary_expected_return_available ? 1 : 0,
      receipt.owners.expected_return_owner === 'allocator_ev_fusion' ? 1 : 0,
      receipt.stages.allocator_selected ? 1 : 0,
      clean(row.signal).toUpperCase() || null,
      receipt.stages.pending_buy_eligible ? 1 : 0,
      receipt.stages.pending_buy_candidate ? 1 : 0,
      receipt.terminal.selection_stage,
      receipt.terminal.rejection_reason,
      receipt.version,
      JSON.stringify(receipt),
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
    pendingBuyCandidateRows,
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
  if (!STRATEGY_FORMAL_LABELER_VERSIONS.some((version) => version === input.labelerVersion)) {
    throw new Error(`strategy_label_matrix_nonformal_labeler:${input.labelerVersion || 'missing'}`)
  }
  if (!clean(input.evidenceArtifactId)) {
    throw new Error('selection_evidence_artifact_missing')
  }
  const referenceKeys = new Set<string>()
  for (const row of input.references) {
    const symbol = clean(row.symbol)
    const key = `${row.signal_date}|${symbol}|${row.producer_run_id}`
    if (
      !symbol
      || row.signal_date !== input.signalDate
      || row.producer_run_id !== input.producerRunId
      || row.strategy_labeler_version !== input.labelerVersion
      || row.strategy_registry_checksum !== input.strategyRegistryChecksum
      || referenceKeys.has(key)
    ) {
      throw new Error(`selection_reference_contract_mismatch:${key}`)
    }
    referenceKeys.add(key)
  }
  const strategyKeys = new Set<string>()
  const matrixKeys = new Set<string>()
  for (const row of input.matrix) {
    const symbol = clean(row.symbol)
    const strategyKey = `${row.strategy_id}|${row.strategy_version}`
    const referenceKey = `${row.signal_date}|${symbol}|${row.producer_run_id}`
    const matrixKey = `${referenceKey}|${strategyKey}`
    if (
      !referenceKeys.has(referenceKey)
      || row.signal_date !== input.signalDate
      || row.producer_run_id !== input.producerRunId
      || row.labeler_version !== input.labelerVersion
      || row.strategy_registry_checksum !== input.strategyRegistryChecksum
      || matrixKeys.has(matrixKey)
    ) {
      throw new Error(`strategy_label_matrix_row_contract_mismatch:${matrixKey}`)
    }
    strategyKeys.add(strategyKey)
    matrixKeys.add(matrixKey)
  }
  if (referenceKeys.size !== input.references.length || strategyKeys.size !== input.strategyCount) {
    throw new Error(
      `strategy_label_matrix_grid_identity_mismatch:${referenceKeys.size}/${input.references.length}:${strategyKeys.size}/${input.strategyCount}`,
    )
  }
  const stockIds = await resolveReferenceStockIds(identityDb, input.references)
  const previousRoutingRows = await db.prepare(`
    SELECT symbol, strategy_router_version, strategy_router_score,
           strategy_challenger_route_version, strategy_challenger_route_score
      FROM selection_reference_snapshots_v1
     WHERE producer_run_id=?
  `).bind(input.producerRunId).all<Pick<
    SelectionReferenceRowV1,
    'symbol' | 'strategy_router_version' | 'strategy_router_score'
      | 'strategy_challenger_route_version' | 'strategy_challenger_route_score'
  >>()
  const previousRoutingBySymbol = new Map(
    (previousRoutingRows.results ?? []).map((row) => [clean(row.symbol), row]),
  )
  const effectiveReferences = input.references.map((row) => {
    const previousRouting = previousRoutingBySymbol.get(clean(row.symbol))
    return {
      ...row,
      strategy_router_version: row.strategy_router_version ?? previousRouting?.strategy_router_version ?? null,
      strategy_router_score: row.strategy_router_score ?? previousRouting?.strategy_router_score ?? null,
      strategy_challenger_route_version:
        row.strategy_challenger_route_version ?? previousRouting?.strategy_challenger_route_version ?? null,
      strategy_challenger_route_score:
        row.strategy_challenger_route_score ?? previousRouting?.strategy_challenger_route_score ?? null,
    }
  })
  const referencePayload = [...effectiveReferences]
    .sort((left, right) => clean(left.symbol).localeCompare(clean(right.symbol)))
    .map((row) => [
      row.signal_date, clean(row.symbol), row.producer_run_id, stockIds.get(clean(row.symbol)) ?? null,
      row.name ?? null, row.market_segment ?? null, row.sector ?? null,
      row.feature_available, row.feature_rejection_reason ?? null, row.strategy_selected,
      row.selection_stage, row.rejection_reason ?? null, row.score_v2 ?? null, row.score_components ?? null,
      row.strategy_labeler_version ?? null, row.strategy_affinity_version ?? null,
      row.strategy_router_version ?? null, row.strategy_router_score ?? null,
      row.strategy_challenger_affinity_version ?? null,
      row.strategy_challenger_route_version ?? null, row.strategy_challenger_route_score ?? null,
      row.strategy_registry_checksum,
    ])
  const matrixPayload = [...input.matrix]
    .sort((left, right) => (
      `${left.signal_date}|${clean(left.symbol)}|${left.strategy_id}|${left.strategy_version}`
        .localeCompare(`${right.signal_date}|${clean(right.symbol)}|${right.strategy_id}|${right.strategy_version}`)
    ))
    .map((row) => [
      row.signal_date, clean(row.symbol), row.producer_run_id, row.strategy_id, row.strategy_version,
      row.strategy_status, row.alpha_bucket, row.family_id, row.production_owner, row.strategy_hit,
      row.weak_label, row.affinity, row.affinity_version ?? null, row.match_strength, row.threshold_margin,
      row.affinity_evidence_count, row.position_weight, row.challenger_affinity,
      row.challenger_affinity_version ?? null, row.challenger_position_weight, row.overlap,
      row.evaluable, row.evaluability_status, row.unavailable_reason ?? null,
      row.labeler_version, row.strategy_registry_checksum,
    ])
  const payloadChecksum = await sha256Text(JSON.stringify({
    schema: 'selection-evidence-canonical-payload-v1',
    signalDate: input.signalDate,
    producerRunId: input.producerRunId,
    strategyCount: input.strategyCount,
    strategyRegistryChecksum: input.strategyRegistryChecksum,
    labelerVersion: input.labelerVersion,
    referenceContractVersion: SELECTION_REFERENCE_CONTRACT_VERSION,
    matrixVersion: STRATEGY_LABEL_MATRIX_VERSION,
    evidenceArtifactId: input.evidenceArtifactId,
    references: referencePayload,
    matrix: matrixPayload,
  }))
  type ReadyRun = {
    status: string
    signal_date: string
    reference_candidate_count: number | string
    strategy_count: number | string
    expected_cell_count: number | string
    persisted_cell_count: number | string
    strategy_registry_checksum: string
    labeler_version: string
    reference_contract_version: string
    evidence_artifact_id: string | null
    payload_checksum: string | null
    promotion_attempt_id: string | null
  }
  const readRun = () => db.prepare(`
    SELECT status, signal_date, reference_candidate_count, strategy_count, expected_cell_count,
           persisted_cell_count, strategy_registry_checksum, labeler_version, reference_contract_version,
           evidence_artifact_id, payload_checksum, promotion_attempt_id
      FROM strategy_label_matrix_runs_v4
     WHERE producer_run_id = ?
  `).bind(input.producerRunId).first<ReadyRun>()
  const verifyReadyCanonical = async (existing: ReadyRun | null): Promise<boolean> => {
    if (existing?.status !== 'ready') return false
    const same = clean(existing.signal_date) === input.signalDate
      && Number(existing.reference_candidate_count) === effectiveReferences.length
      && Number(existing.strategy_count) === input.strategyCount
      && Number(existing.expected_cell_count) === expectedCells
      && Number(existing.persisted_cell_count) === expectedCells
      && clean(existing.strategy_registry_checksum) === input.strategyRegistryChecksum
      && clean(existing.labeler_version) === input.labelerVersion
      && clean(existing.reference_contract_version) === SELECTION_REFERENCE_CONTRACT_VERSION
      && clean(existing.evidence_artifact_id) === input.evidenceArtifactId
      && clean(existing.payload_checksum) === payloadChecksum
      && clean(existing.promotion_attempt_id).length > 0
    if (!same) throw new Error('strategy_label_matrix_immutable_run_conflict')

    const expectedReferenceIdentity = JSON.stringify(effectiveReferences.map((row) => ({
      symbol: clean(row.symbol),
      stock_id: stockIds.get(clean(row.symbol)) ?? null,
    })))
    const expectedReferenceSymbols = JSON.stringify(effectiveReferences.map((row) => clean(row.symbol)))
    const expectedStrategies = JSON.stringify([...new Map(input.matrix.map((row) => [
      `${row.strategy_id}|${row.strategy_version}`,
      { strategy_id: row.strategy_id, strategy_version: row.strategy_version },
    ])).values()])
    const [referenceCoverage, matrixCoverage] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) row_count,
               SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(?) j
                  WHERE json_extract(j.value, '$.symbol')=r.symbol
                    AND CAST(json_extract(j.value, '$.stock_id') AS INTEGER)=r.stock_id
               ) THEN 1 ELSE 0 END) identity_count,
               SUM(CASE
                 WHEN r.signal_date=? AND r.hard_gate_passed=1
                  AND r.strategy_labeler_version=? AND r.strategy_registry_checksum=?
                  AND r.feature_contract_version=? AND r.evidence_artifact_id=?
                 THEN 1 ELSE 0 END) contract_count
          FROM selection_reference_snapshots_v1 r
         WHERE r.producer_run_id=?
      `).bind(
        expectedReferenceIdentity,
        input.signalDate,
        input.labelerVersion,
        input.strategyRegistryChecksum,
        SELECTION_REFERENCE_CONTRACT_VERSION,
        input.evidenceArtifactId,
        input.producerRunId,
      ).first<{ row_count: number; identity_count: number; contract_count: number }>(),
      db.prepare(`
        SELECT COUNT(*) row_count,
               SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(?) refs WHERE refs.value=m.symbol
               ) THEN 1 ELSE 0 END) reference_identity_count,
               SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(?) strategies
                  WHERE json_extract(strategies.value, '$.strategy_id')=m.strategy_id
                    AND json_extract(strategies.value, '$.strategy_version')=m.strategy_version
               ) THEN 1 ELSE 0 END) strategy_identity_count,
               SUM(CASE
                 WHEN m.signal_date=? AND m.labeler_version=?
                  AND m.strategy_registry_checksum=? AND m.reference_contract_version=?
                 THEN 1 ELSE 0 END) contract_count
          FROM strategy_label_matrix_v4 m
         WHERE m.producer_run_id=?
      `).bind(
        expectedReferenceSymbols,
        expectedStrategies,
        input.signalDate,
        input.labelerVersion,
        input.strategyRegistryChecksum,
        SELECTION_REFERENCE_CONTRACT_VERSION,
        input.producerRunId,
      ).first<{
        row_count: number
        reference_identity_count: number
        strategy_identity_count: number
        contract_count: number
      }>(),
    ])
    if (
      Number(referenceCoverage?.row_count ?? 0) !== effectiveReferences.length
      || Number(referenceCoverage?.identity_count ?? 0) !== effectiveReferences.length
      || Number(referenceCoverage?.contract_count ?? 0) !== effectiveReferences.length
      || Number(matrixCoverage?.row_count ?? 0) !== expectedCells
      || Number(matrixCoverage?.reference_identity_count ?? 0) !== expectedCells
      || Number(matrixCoverage?.strategy_identity_count ?? 0) !== expectedCells
      || Number(matrixCoverage?.contract_count ?? 0) !== expectedCells
    ) {
      throw new Error(
        `selection_reference_ready_contract_mismatch:${referenceCoverage?.contract_count ?? 0}/${effectiveReferences.length}`
        + `:${matrixCoverage?.contract_count ?? 0}/${expectedCells}:payload=${payloadChecksum}`,
      )
    }
    return true
  }

  if (await verifyReadyCanonical(await readRun())) {
    return { referenceRows: effectiveReferences.length, matrixRows: expectedCells }
  }

  const attemptId = crypto.randomUUID()
  const acquisition = await db.prepare(`
    INSERT INTO selection_evidence_staging_runs_v1 (
      producer_run_id, attempt_id, signal_date, status,
      expected_reference_count, expected_strategy_count, expected_cell_count,
      staged_reference_count, staged_cell_count, strategy_registry_checksum,
      labeler_version, reference_contract_version, evidence_artifact_id, payload_checksum
    )
    SELECT ?, ?, ?, 'writing', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM strategy_label_matrix_runs_v4 ready
        WHERE ready.producer_run_id=? AND ready.status='ready'
     )
    ON CONFLICT(producer_run_id) DO UPDATE SET
      attempt_id=excluded.attempt_id,
      signal_date=excluded.signal_date,
      status='writing',
      expected_reference_count=excluded.expected_reference_count,
      expected_strategy_count=excluded.expected_strategy_count,
      expected_cell_count=excluded.expected_cell_count,
      staged_reference_count=0,
      staged_cell_count=0,
      strategy_registry_checksum=excluded.strategy_registry_checksum,
      labeler_version=excluded.labeler_version,
      reference_contract_version=excluded.reference_contract_version,
      evidence_artifact_id=excluded.evidence_artifact_id,
      payload_checksum=excluded.payload_checksum,
      error_code=NULL,
      created_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE NOT EXISTS (
      SELECT 1 FROM strategy_label_matrix_runs_v4 ready
       WHERE ready.producer_run_id=excluded.producer_run_id AND ready.status='ready'
    ) AND (
      selection_evidence_staging_runs_v1.status IN ('failed', 'promoted')
      OR (
        selection_evidence_staging_runs_v1.status IN ('writing', 'validated')
        AND selection_evidence_staging_runs_v1.updated_at < datetime('now', '-30 minutes')
      )
    )
  `).bind(
    input.producerRunId,
    attemptId,
    input.signalDate,
    effectiveReferences.length,
    input.strategyCount,
    expectedCells,
    input.strategyRegistryChecksum,
    input.labelerVersion,
    SELECTION_REFERENCE_CONTRACT_VERSION,
    input.evidenceArtifactId,
    payloadChecksum,
    input.producerRunId,
  ).run()
  if (Number(acquisition.meta?.changes ?? 0) !== 1) {
    if (await verifyReadyCanonical(await readRun())) {
      return { referenceRows: effectiveReferences.length, matrixRows: expectedCells }
    }
    throw new Error(`selection_evidence_writer_busy:${input.producerRunId}`)
  }
  await db.batch([
    db.prepare(`
      DELETE FROM selection_reference_snapshots_staging_v1
       WHERE producer_run_id=? AND attempt_id<>?
         AND EXISTS (
           SELECT 1 FROM selection_evidence_staging_runs_v1 owner
            WHERE owner.producer_run_id=? AND owner.attempt_id=? AND owner.status='writing'
         )
    `).bind(input.producerRunId, attemptId, input.producerRunId, attemptId),
    db.prepare(`
      DELETE FROM strategy_label_matrix_staging_v4
       WHERE producer_run_id=? AND attempt_id<>?
         AND EXISTS (
           SELECT 1 FROM selection_evidence_staging_runs_v1 owner
            WHERE owner.producer_run_id=? AND owner.attempt_id=? AND owner.status='writing'
         )
    `).bind(input.producerRunId, attemptId, input.producerRunId, attemptId),
  ])

  const heartbeatWriter = async (): Promise<void> => {
    const heartbeat = await db.prepare(`
      UPDATE selection_evidence_staging_runs_v1
         SET updated_at=CURRENT_TIMESTAMP
       WHERE producer_run_id=? AND attempt_id=? AND status='writing'
    `).bind(input.producerRunId, attemptId).run()
    if (Number(heartbeat.meta?.changes ?? 0) !== 1) {
      throw new Error(`selection_evidence_writer_fenced:${input.producerRunId}:${attemptId}`)
    }
  }

  try {
    const referenceStatements = effectiveReferences.map((row) => {
      return db.prepare(`
        INSERT INTO selection_reference_snapshots_staging_v1 (
          attempt_id, signal_date, symbol, producer_run_id, stock_id, name, market_segment, sector,
          hard_gate_passed, hard_gate_reason, feature_available, feature_rejection_reason, strategy_labeled,
          strategy_selected, ml_selected, l4_selected, ev_owner_available, final_signal,
          selection_stage, rejection_reason, selection_propensity, score_v2, score_components,
          allocation_selected, decision_evidence_reconciled_at,
          strategy_labeler_version, strategy_affinity_version, strategy_router_version, strategy_router_score,
          strategy_challenger_affinity_version, strategy_challenger_route_version, strategy_challenger_route_score,
          strategy_registry_checksum, feature_contract_version, evidence_artifact_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'hard_filters_passed', ?, ?, 1, ?, 0, 0, 0, NULL,
                  ?, ?, 1.0, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        attemptId, row.signal_date, row.symbol, row.producer_run_id,
        stockIds.get(clean(row.symbol)), row.name, row.market_segment, row.sector,
        row.feature_available, row.feature_rejection_reason, row.strategy_selected,
        row.selection_stage, row.rejection_reason, row.score_v2, row.score_components,
        row.strategy_labeler_version, row.strategy_affinity_version,
        row.strategy_router_version, row.strategy_router_score,
        row.strategy_challenger_affinity_version,
        row.strategy_challenger_route_version, row.strategy_challenger_route_score,
        row.strategy_registry_checksum, SELECTION_REFERENCE_CONTRACT_VERSION,
        input.evidenceArtifactId,
      )
    })
    for (let offset = 0; offset < referenceStatements.length; offset += 100) {
      await db.batch(referenceStatements.slice(offset, offset + 100))
      await heartbeatWriter()
    }

    const matrixJsonChunkSize = 1000
    for (let offset = 0; offset < input.matrix.length; offset += matrixJsonChunkSize) {
      const payload = JSON.stringify(input.matrix.slice(offset, offset + matrixJsonChunkSize))
      await db.prepare(`
        INSERT INTO strategy_label_matrix_staging_v4 (
          attempt_id, signal_date, symbol, producer_run_id, strategy_id, strategy_version,
          strategy_status, alpha_bucket, family_id, production_owner,
          strategy_hit, pre_regime_setup_hit, regime_eligible, formal_veto_reason,
          counterfactual_affinity, counterfactual_production_effect,
          weak_label, affinity, affinity_version, match_strength,
          threshold_margin, affinity_evidence_count, position_weight,
          challenger_affinity, challenger_affinity_version, challenger_position_weight, overlap,
          evaluable, evaluability_status, unavailable_reason, label_reason, labeler_version,
          strategy_registry_checksum, reference_contract_version
        )
        SELECT
          ?, json_extract(value, '$.signal_date'), json_extract(value, '$.symbol'),
          json_extract(value, '$.producer_run_id'), json_extract(value, '$.strategy_id'),
          json_extract(value, '$.strategy_version'), json_extract(value, '$.strategy_status'),
          json_extract(value, '$.alpha_bucket'), json_extract(value, '$.family_id'),
          json_extract(value, '$.production_owner'), json_extract(value, '$.strategy_hit'),
          json_extract(value, '$.pre_regime_setup_hit'), json_extract(value, '$.regime_eligible'),
          json_extract(value, '$.formal_veto_reason'), json_extract(value, '$.counterfactual_affinity'),
          json_extract(value, '$.counterfactual_production_effect'),
          json_extract(value, '$.weak_label'), json_extract(value, '$.affinity'),
          json_extract(value, '$.affinity_version'), json_extract(value, '$.match_strength'),
          json_extract(value, '$.threshold_margin'), json_extract(value, '$.affinity_evidence_count'),
          json_extract(value, '$.position_weight'), json_extract(value, '$.challenger_affinity'),
          json_extract(value, '$.challenger_affinity_version'), json_extract(value, '$.challenger_position_weight'),
          json_extract(value, '$.overlap'), json_extract(value, '$.evaluable'),
          json_extract(value, '$.evaluability_status'), json_extract(value, '$.unavailable_reason'),
          NULL, json_extract(value, '$.labeler_version'),
          json_extract(value, '$.strategy_registry_checksum'), ?
          FROM json_each(?)
      `).bind(attemptId, SELECTION_REFERENCE_CONTRACT_VERSION, payload).run()
      await heartbeatWriter()
    }

    const staged = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM selection_reference_snapshots_staging_v1
          WHERE attempt_id=?) reference_rows,
        (SELECT COUNT(*) FROM selection_reference_snapshots_staging_v1
          WHERE attempt_id=? AND stock_id IS NOT NULL) identity_rows,
        (SELECT COUNT(*) FROM selection_reference_snapshots_staging_v1
          WHERE attempt_id=? AND signal_date=? AND producer_run_id=?
            AND strategy_labeler_version=? AND strategy_registry_checksum=?
            AND feature_contract_version=? AND evidence_artifact_id=?) reference_contract_rows,
        (SELECT COUNT(*) FROM strategy_label_matrix_staging_v4
          WHERE attempt_id=?) matrix_rows,
        (SELECT COUNT(*) FROM strategy_label_matrix_staging_v4
          WHERE attempt_id=? AND signal_date=? AND producer_run_id=?
            AND labeler_version=? AND strategy_registry_checksum=?
            AND reference_contract_version=?) matrix_contract_rows
    `).bind(
      attemptId,
      attemptId,
      attemptId, input.signalDate, input.producerRunId, input.labelerVersion,
      input.strategyRegistryChecksum, SELECTION_REFERENCE_CONTRACT_VERSION, input.evidenceArtifactId,
      attemptId,
      attemptId, input.signalDate, input.producerRunId, input.labelerVersion,
      input.strategyRegistryChecksum, SELECTION_REFERENCE_CONTRACT_VERSION,
    ).first<{
      reference_rows: number | string
      identity_rows: number | string
      reference_contract_rows: number | string
      matrix_rows: number | string
      matrix_contract_rows: number | string
    }>()
    const referenceRows = Number(staged?.reference_rows ?? 0)
    const identityRows = Number(staged?.identity_rows ?? 0)
    const referenceContractRows = Number(staged?.reference_contract_rows ?? 0)
    const matrixRows = Number(staged?.matrix_rows ?? 0)
    const matrixContractRows = Number(staged?.matrix_contract_rows ?? 0)
    if (
      referenceRows !== input.references.length
      || identityRows !== referenceRows
      || referenceContractRows !== referenceRows
      || matrixRows !== expectedCells
      || matrixContractRows !== expectedCells
    ) {
      throw new Error(
        `selection_evidence_staging_coverage_mismatch:${referenceRows}/${input.references.length}`
        + `:identity=${identityRows}/${referenceRows}:reference_contract=${referenceContractRows}/${referenceRows}`
        + `:matrix=${matrixRows}/${expectedCells}:matrix_contract=${matrixContractRows}/${expectedCells}`,
      )
    }

    await db.prepare(`
      UPDATE selection_evidence_staging_runs_v1
         SET status='validated', staged_reference_count=?, staged_cell_count=?,
             error_code=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE producer_run_id=? AND attempt_id=? AND status='writing' AND payload_checksum=?
    `).bind(referenceRows, matrixRows, input.producerRunId, attemptId, payloadChecksum).run()
    const validationReceipt = await db.prepare(`
      SELECT status, payload_checksum
        FROM selection_evidence_staging_runs_v1
       WHERE producer_run_id=? AND attempt_id=?
    `).bind(input.producerRunId, attemptId).first<{ status: string; payload_checksum: string | null }>()
    if (validationReceipt?.status !== 'validated' || clean(validationReceipt.payload_checksum) !== payloadChecksum) {
      throw new Error(`selection_evidence_writer_fenced:${input.producerRunId}:${attemptId}`)
    }

    const validatedAttempt = `
      SELECT 1
        FROM selection_evidence_staging_runs_v1 s
       WHERE s.producer_run_id=? AND s.attempt_id=? AND s.status='validated'
         AND s.payload_checksum=?
         AND s.staged_reference_count=s.expected_reference_count
         AND s.staged_cell_count=s.expected_cell_count
         AND NOT EXISTS (
           SELECT 1 FROM strategy_label_matrix_runs_v4 ready
            WHERE ready.producer_run_id=s.producer_run_id AND ready.status='ready'
         )
    `
    await db.batch([
      db.prepare(`
        DELETE FROM strategy_label_matrix_v4
         WHERE producer_run_id=? AND EXISTS (${validatedAttempt})
      `).bind(input.producerRunId, input.producerRunId, attemptId, payloadChecksum),
      db.prepare(`
        DELETE FROM selection_reference_snapshots_v1
         WHERE producer_run_id=? AND EXISTS (${validatedAttempt})
      `).bind(input.producerRunId, input.producerRunId, attemptId, payloadChecksum),
      db.prepare(`
        INSERT INTO selection_reference_snapshots_v1 (
          signal_date, symbol, producer_run_id, stock_id, name, market_segment, sector,
          hard_gate_passed, hard_gate_reason, feature_available, feature_rejection_reason, strategy_labeled,
          strategy_selected, ml_selected, l4_selected, ev_owner_available, final_signal,
          selection_stage, rejection_reason, selection_propensity, score_v2, score_components,
          allocation_selected, decision_evidence_reconciled_at,
          strategy_labeler_version, strategy_affinity_version, strategy_router_version, strategy_router_score,
          strategy_challenger_affinity_version, strategy_challenger_route_version, strategy_challenger_route_score,
          strategy_registry_checksum, feature_contract_version, evidence_artifact_id
        )
        SELECT
          st.signal_date, st.symbol, st.producer_run_id, st.stock_id, st.name, st.market_segment, st.sector,
          st.hard_gate_passed, st.hard_gate_reason, st.feature_available, st.feature_rejection_reason, st.strategy_labeled,
          st.strategy_selected, st.ml_selected, st.l4_selected, st.ev_owner_available, st.final_signal,
          st.selection_stage, st.rejection_reason, st.selection_propensity, st.score_v2, st.score_components,
          st.allocation_selected, st.decision_evidence_reconciled_at,
          st.strategy_labeler_version, st.strategy_affinity_version, st.strategy_router_version, st.strategy_router_score,
          st.strategy_challenger_affinity_version, st.strategy_challenger_route_version, st.strategy_challenger_route_score,
          st.strategy_registry_checksum, st.feature_contract_version, st.evidence_artifact_id
          FROM selection_reference_snapshots_staging_v1 st
          JOIN selection_evidence_staging_runs_v1 s
            ON s.producer_run_id=st.producer_run_id AND s.attempt_id=st.attempt_id
         WHERE st.attempt_id=? AND s.status='validated' AND s.payload_checksum=?
           AND s.staged_reference_count=s.expected_reference_count
           AND s.staged_cell_count=s.expected_cell_count
           AND NOT EXISTS (
             SELECT 1 FROM strategy_label_matrix_runs_v4 ready
              WHERE ready.producer_run_id=s.producer_run_id AND ready.status='ready'
           )
      `).bind(attemptId, payloadChecksum),
      db.prepare(`
        INSERT INTO strategy_label_matrix_v4 (
          signal_date, symbol, producer_run_id, strategy_id, strategy_version,
          strategy_status, alpha_bucket, family_id, production_owner,
          strategy_hit, pre_regime_setup_hit, regime_eligible, formal_veto_reason,
          counterfactual_affinity, counterfactual_production_effect,
          weak_label, affinity, affinity_version, match_strength,
          threshold_margin, affinity_evidence_count, position_weight,
          challenger_affinity, challenger_affinity_version, challenger_position_weight, overlap,
          evaluable, evaluability_status, unavailable_reason, label_reason, labeler_version,
          strategy_registry_checksum, reference_contract_version
        )
        SELECT
          st.signal_date, st.symbol, st.producer_run_id, st.strategy_id, st.strategy_version,
          st.strategy_status, st.alpha_bucket, st.family_id, st.production_owner,
          st.strategy_hit, st.pre_regime_setup_hit, st.regime_eligible, st.formal_veto_reason,
          st.counterfactual_affinity, st.counterfactual_production_effect,
          st.weak_label, st.affinity, st.affinity_version, st.match_strength,
          st.threshold_margin, st.affinity_evidence_count, st.position_weight,
          st.challenger_affinity, st.challenger_affinity_version, st.challenger_position_weight, st.overlap,
          st.evaluable, st.evaluability_status, st.unavailable_reason, st.label_reason, st.labeler_version,
          st.strategy_registry_checksum, st.reference_contract_version
          FROM strategy_label_matrix_staging_v4 st
          JOIN selection_evidence_staging_runs_v1 s
            ON s.producer_run_id=st.producer_run_id AND s.attempt_id=st.attempt_id
         WHERE st.attempt_id=? AND s.status='validated' AND s.payload_checksum=?
           AND s.staged_reference_count=s.expected_reference_count
           AND s.staged_cell_count=s.expected_cell_count
           AND NOT EXISTS (
             SELECT 1 FROM strategy_label_matrix_runs_v4 ready
              WHERE ready.producer_run_id=s.producer_run_id AND ready.status='ready'
           )
      `).bind(attemptId, payloadChecksum),
      db.prepare(`
        INSERT INTO strategy_label_matrix_runs_v4 (
          producer_run_id, signal_date, status, reference_candidate_count,
          strategy_count, expected_cell_count, persisted_cell_count,
          strategy_registry_checksum, labeler_version, reference_contract_version,
          evidence_artifact_id, payload_checksum, promotion_attempt_id, error_code
        )
        SELECT producer_run_id, signal_date, 'ready', expected_reference_count,
               expected_strategy_count, expected_cell_count, staged_cell_count,
               strategy_registry_checksum, labeler_version, reference_contract_version,
               evidence_artifact_id, payload_checksum, ?, NULL
          FROM selection_evidence_staging_runs_v1
         WHERE producer_run_id=? AND attempt_id=? AND status='validated' AND payload_checksum=?
           AND staged_reference_count=expected_reference_count
           AND staged_cell_count=expected_cell_count
        ON CONFLICT(producer_run_id) DO UPDATE SET
          signal_date=excluded.signal_date,
          status='ready',
          reference_candidate_count=excluded.reference_candidate_count,
          strategy_count=excluded.strategy_count,
          expected_cell_count=excluded.expected_cell_count,
          persisted_cell_count=excluded.persisted_cell_count,
          strategy_registry_checksum=excluded.strategy_registry_checksum,
          labeler_version=excluded.labeler_version,
          reference_contract_version=excluded.reference_contract_version,
          evidence_artifact_id=excluded.evidence_artifact_id,
          payload_checksum=excluded.payload_checksum,
          promotion_attempt_id=excluded.promotion_attempt_id,
          error_code=NULL,
          updated_at=CURRENT_TIMESTAMP
        WHERE strategy_label_matrix_runs_v4.status <> 'ready'
      `).bind(attemptId, input.producerRunId, attemptId, payloadChecksum),
      db.prepare(`
        UPDATE selection_evidence_staging_runs_v1 AS s
           SET status='promoted', updated_at=CURRENT_TIMESTAMP
         WHERE producer_run_id=? AND attempt_id=? AND status='validated' AND payload_checksum=?
           AND EXISTS (
             SELECT 1 FROM strategy_label_matrix_runs_v4 ready
              WHERE ready.producer_run_id=s.producer_run_id AND ready.status='ready'
                AND ready.promotion_attempt_id=? AND ready.payload_checksum=?
                AND ready.evidence_artifact_id=s.evidence_artifact_id
           )
      `).bind(input.producerRunId, attemptId, payloadChecksum, attemptId, payloadChecksum),
      db.prepare(`
        DELETE FROM strategy_label_matrix_staging_v4
         WHERE attempt_id=? AND EXISTS (
           SELECT 1 FROM selection_evidence_staging_runs_v1 owner
            WHERE owner.producer_run_id=? AND owner.attempt_id=? AND owner.status='promoted'
         )
      `).bind(attemptId, input.producerRunId, attemptId),
      db.prepare(`
        DELETE FROM selection_reference_snapshots_staging_v1
         WHERE attempt_id=? AND EXISTS (
           SELECT 1 FROM selection_evidence_staging_runs_v1 owner
            WHERE owner.producer_run_id=? AND owner.attempt_id=? AND owner.status='promoted'
         )
      `).bind(attemptId, input.producerRunId, attemptId),
    ])

    const cutoverReceipt = await db.prepare(`
      SELECT status, payload_checksum
        FROM selection_evidence_staging_runs_v1
       WHERE producer_run_id=? AND attempt_id=?
    `).bind(input.producerRunId, attemptId).first<{ status: string; payload_checksum: string | null }>()
    if (
      cutoverReceipt?.status !== 'promoted'
      || clean(cutoverReceipt.payload_checksum) !== payloadChecksum
    ) {
      if (await verifyReadyCanonical(await readRun())) {
        await db.batch([
          db.prepare(`
            UPDATE selection_evidence_staging_runs_v1
               SET status='failed', error_code='concurrent_idempotent_ready', updated_at=CURRENT_TIMESTAMP
             WHERE producer_run_id=? AND attempt_id=? AND status='validated'
          `).bind(input.producerRunId, attemptId),
          db.prepare(`DELETE FROM strategy_label_matrix_staging_v4 WHERE attempt_id=?`).bind(attemptId),
          db.prepare(`DELETE FROM selection_reference_snapshots_staging_v1 WHERE attempt_id=?`).bind(attemptId),
        ])
        return { referenceRows, matrixRows }
      }
      throw new Error(`selection_evidence_writer_fenced:${input.producerRunId}:${attemptId}`)
    }
    if (!await verifyReadyCanonical(await readRun())) {
      throw new Error(`selection_evidence_atomic_cutover_readback_mismatch:${input.producerRunId}`)
    }
    return { referenceRows, matrixRows }
  } catch (error) {
    await db.prepare(`
      UPDATE selection_evidence_staging_runs_v1
         SET status='failed', error_code=?, updated_at=CURRENT_TIMESTAMP
       WHERE producer_run_id=? AND attempt_id=? AND status IN ('writing', 'validated')
    `).bind(
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      input.producerRunId,
      attemptId,
    ).run().catch(() => {})
    throw error
  }
}
