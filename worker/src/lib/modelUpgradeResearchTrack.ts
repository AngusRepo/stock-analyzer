import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export type ModelUpgradeStage =
  | 'production_slot_member'
  | 'shadow_challenger'
  | 'benchmark_only'
  | 'meta_optimizer'
  | 'state_space_overlay'

export type ModelUpgradeCandidateId =
  | 'Chronos2ZeroShot'
  | 'Chronos2LoRA'
  | 'ResidualMLP'
  | 'GNN'
  | 'TabM'
  | 'iTransformer'
  | 'TimesFM'
  | 'Moirai'
  | 'GAOptimizer'
  | 'KalmanFilter'
  | 'MarkovSwitching'

export interface ModelUpgradeCandidate {
  id: ModelUpgradeCandidateId
  stage: ModelUpgradeStage
  parent_slot?: string
  family: string
  role: string
  vote_weight: number
  can_predict: boolean
  can_vote: boolean
  can_promote_directly: boolean
  requires_review_packet: boolean
  evidence_required: string[]
  notes: string
}

export const P7_MODEL_UPGRADE_TRACK_VERSION = 'p7-model-upgrade-track-v1'

export const P7_MODEL_UPGRADE_CANDIDATES: readonly ModelUpgradeCandidate[] = [
  {
    id: 'Chronos2ZeroShot',
    stage: 'production_slot_member',
    parent_slot: 'Chronos',
    family: 'foundation_time_series',
    role: 'production Chronos member; contributes through the single Chronos alpha slot',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: false,
    evidence_required: ['forecast_validation', 'outcome_join', 'rank_ic'],
    notes: 'Does not increase the alpha denominator; the user-facing model remains Chronos.',
  },
  {
    id: 'Chronos2LoRA',
    stage: 'production_slot_member',
    parent_slot: 'Chronos',
    family: 'foundation_time_series_adapter',
    role: 'optional fine-tuned Chronos member; contributes through the single Chronos alpha slot when configured',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: false,
    evidence_required: ['adapter_metadata', 'forecast_validation', 'outcome_join', 'rank_ic'],
    notes: 'Adapter evidence belongs to the Chronos slot, not a new production model count.',
  },
  {
    id: 'ResidualMLP',
    stage: 'shadow_challenger',
    family: 'tabular_neural_shadow',
    role: 'shadow prediction challenger for stacking residuals',
    vote_weight: 0,
    can_predict: true,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['shadow_ab', 'walk_forward', 'pbo', 'deflated_sharpe', 'model_cpcv'],
    notes: 'May produce predictions, but must stay out of production voting until lifecycle promotion passes.',
  },
  {
    id: 'GNN',
    stage: 'shadow_challenger',
    family: 'cross_stock_graph_shadow',
    role: 'shadow prediction challenger for cross-stock graph relation evidence',
    vote_weight: 0,
    can_predict: true,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['graph_spec', 'shadow_ab', 'walk_forward', 'pbo', 'deflated_sharpe', 'model_cpcv'],
    notes: 'Graph spec and leakage controls must be explicit before promotion review.',
  },
  {
    id: 'TabM',
    stage: 'benchmark_only',
    family: 'tabular_deep_learning',
    role: 'research benchmark candidate for tabular neural performance',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['experiment_registry', 'feature_policy', 'walk_forward', 'pbo', 'cost_profile'],
    notes: 'Benchmark is not a challenger until a reviewed experiment produces repeatable evidence.',
  },
  {
    id: 'iTransformer',
    stage: 'benchmark_only',
    family: 'time_series_transformer',
    role: 'research benchmark candidate for inverted time-series transformer evidence',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['experiment_registry', 'sequence_policy', 'walk_forward', 'pbo', 'cost_profile'],
    notes: 'Benchmark-only prevents accidental production inference cost growth.',
  },
  {
    id: 'TimesFM',
    stage: 'benchmark_only',
    family: 'foundation_time_series',
    role: 'research benchmark candidate against the Chronos family',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['experiment_registry', 'forecast_validation', 'walk_forward', 'cost_profile'],
    notes: 'Useful for evidence comparison; not a production replacement without a review packet.',
  },
  {
    id: 'Moirai',
    stage: 'benchmark_only',
    family: 'foundation_time_series',
    role: 'research benchmark candidate against the Chronos family',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['experiment_registry', 'forecast_validation', 'walk_forward', 'cost_profile'],
    notes: 'Useful for evidence comparison; not a production replacement without a review packet.',
  },
  {
    id: 'GAOptimizer',
    stage: 'meta_optimizer',
    family: 'genetic_meta_optimizer',
    role: 'learns ensemble, strategy, and risk parameters; never emits stock alpha votes',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['walk_forward', 'pbo', 'monte_carlo_plateau', 'transaction_cost_sensitivity'],
    notes: 'GA belongs to meta optimizer learning, not challenger shadow or alpha model voting.',
  },
  {
    id: 'KalmanFilter',
    stage: 'state_space_overlay',
    family: 'state_space',
    role: 'noise smoothing and uncertainty overlay for regime/risk context',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: false,
    evidence_required: ['overlay_diagnostics', 'regime_context'],
    notes: 'State-space overlay only; excluded from alpha vote and model count.',
  },
  {
    id: 'MarkovSwitching',
    stage: 'state_space_overlay',
    family: 'state_space',
    role: 'regime-state overlay for bull/bear/volatile context',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: false,
    evidence_required: ['overlay_diagnostics', 'regime_context'],
    notes: 'State-space overlay only; excluded from alpha vote and model count.',
  },
] as const

export function listModelUpgradeCandidates(stage?: ModelUpgradeStage): ModelUpgradeCandidate[] {
  assertOwnerCanOwn('research', 'experiment_registry')
  return P7_MODEL_UPGRADE_CANDIDATES
    .filter((candidate) => !stage || candidate.stage === stage)
    .map((candidate) => ({ ...candidate, evidence_required: [...candidate.evidence_required] }))
}

export function buildP7ModelUpgradeReviewPacket(): string {
  assertOwnerCanOwn('research', 'review_packet')
  const byStage = new Map<ModelUpgradeStage, ModelUpgradeCandidate[]>()
  for (const candidate of P7_MODEL_UPGRADE_CANDIDATES) {
    byStage.set(candidate.stage, [...(byStage.get(candidate.stage) ?? []), candidate])
  }
  const lines = [
    `P7 Model Upgrade Research Track: ${P7_MODEL_UPGRADE_TRACK_VERSION}`,
    'Rules: benchmark-only is not challenger; shadow challenger does not vote; GA is meta optimizer; Chronos members keep one Chronos slot.',
  ]
  for (const [stage, candidates] of byStage.entries()) {
    lines.push(`${stage}: ${candidates.map((candidate) => candidate.id).join(', ')}`)
  }
  return lines.join('\n')
}

export function validateP7ModelUpgradeTrack(): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const candidate of P7_MODEL_UPGRADE_CANDIDATES) {
    if (seen.has(candidate.id)) errors.push(`duplicate_candidate:${candidate.id}`)
    seen.add(candidate.id)
    if (candidate.stage === 'benchmark_only' && (candidate.can_predict || candidate.can_vote || candidate.vote_weight !== 0)) {
      errors.push(`benchmark_candidate_not_passive:${candidate.id}`)
    }
    if (candidate.stage === 'shadow_challenger' && (candidate.can_vote || candidate.vote_weight !== 0)) {
      errors.push(`shadow_candidate_can_vote:${candidate.id}`)
    }
    if (candidate.stage === 'meta_optimizer' && (candidate.can_predict || candidate.can_vote)) {
      errors.push(`meta_optimizer_misclassified:${candidate.id}`)
    }
    if (candidate.stage === 'production_slot_member' && candidate.parent_slot !== 'Chronos') {
      errors.push(`production_member_without_parent_slot:${candidate.id}`)
    }
    if (candidate.can_promote_directly) errors.push(`direct_promote_not_allowed:${candidate.id}`)
  }
  return { ok: errors.length === 0, errors }
}
