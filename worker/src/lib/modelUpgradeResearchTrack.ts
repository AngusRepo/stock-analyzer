import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export type ModelUpgradeStage =
  | 'production_slot_member'
  | 'production_artifact_required'
  | 'shadow_challenger'
  | 'benchmark_only'
  | 'meta_optimizer'
  | 'state_space_overlay'

export type ModelUpgradeCandidateId =
  | 'ResidualMLP'
  | 'DLinear'
  | 'PatchTST'
  | 'GNN'
  | 'TabM'
  | 'iTransformer'
  | 'TimesFM'
  | 'TimesFM25'
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
    id: 'DLinear',
    stage: 'production_slot_member',
    family: 'time_series_linear_current',
    role: 'L3 sequence family production slot; current StockVision DLinear retained after maintained-library comparison',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['production_artifact', 'sequence_policy', 'walk_forward', 'pbo', 'cost_profile', 'model_cpcv'],
    notes: 'Production slot member; maintained-library comparison lost and was removed from the upgrade track.',
  },
  {
    id: 'PatchTST',
    stage: 'production_slot_member',
    family: 'time_series_neuralforecast_patchtst',
    role: 'L3 sequence family production slot backed by NeuralForecast PatchTST artifact serving',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['production_artifact', 'sequence_policy', 'walk_forward', 'pbo', 'cost_profile', 'model_cpcv'],
    notes: 'NeuralForecast PatchTST won before/after replay; legacy in-repo Torch PatchTST adapter removed.',
  },
  {
    id: 'GNN',
    stage: 'production_slot_member',
    family: 'cross_stock_graphsage',
    role: 'L3 graph family production slot; GraphSAGE batch-context runtime votes when lifecycle IC weight is positive',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['production_artifact', 'graphsage_artifact', 'batch_context_graph_spec', 'walk_forward', 'pbo', 'deflated_sharpe', 'model_cpcv', 'positive_ic'],
    notes: 'Production slot member; missing GraphSAGE batch-context artifact or non-positive lifecycle evidence yields zero contribution at serving time.',
  },
  {
    id: 'TabM',
    stage: 'production_slot_member',
    family: 'tabular_deep_learning',
    role: 'L3 tabular neural family production slot; artifact-backed runtime votes when lifecycle IC weight is positive',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['production_artifact', 'feature_policy', 'walk_forward', 'pbo', 'cost_profile', 'positive_ic'],
    notes: 'Production slot member; missing artifact or non-positive lifecycle evidence yields zero contribution at serving time.',
  },
  {
    id: 'iTransformer',
    stage: 'production_slot_member',
    family: 'time_series_neuralforecast_itransformer',
    role: 'L3 sequence family production slot backed by NeuralForecast iTransformer artifact serving',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['production_artifact', 'sequence_policy', 'walk_forward', 'pbo', 'cost_profile', 'positive_ic'],
    notes: 'NeuralForecast iTransformer won before/after replay; legacy simplified Torch iTransformer adapter removed.',
  },
  {
    id: 'TimesFM25',
    stage: 'benchmark_only',
    family: 'foundation_time_series_maintained_runtime',
    role: 'TimesFM 2.5 migration benchmark against current TimesFM config artifact',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['forecast_validation', 'walk_forward', 'cost_profile', 'serving_parity', 'positive_ic'],
    notes: 'Temporary migration benchmark; if it wins and parity passes, cut TimesFM config to 2.5 then remove the adapter.',
  },
  {
    id: 'TimesFM',
    stage: 'production_slot_member',
    family: 'foundation_time_series',
    role: 'L3 sequence foundation production slot; config-backed TimesFM runtime votes when lifecycle IC weight is positive',
    vote_weight: 1,
    can_predict: true,
    can_vote: true,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['production_artifact', 'forecast_validation', 'walk_forward', 'cost_profile', 'positive_ic'],
    notes: 'Production slot member; missing config, unavailable model runtime, or non-positive lifecycle evidence yields zero contribution at serving time.',
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
    'Rules: production_slot_member votes only through artifact-backed serving and lifecycle IC; benchmark-only is not challenger; shadow challenger does not vote; GA is meta optimizer.',
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
    if (candidate.stage === 'production_slot_member' && (!candidate.can_predict || !candidate.can_vote || candidate.vote_weight <= 0)) {
      errors.push(`production_slot_member_not_active_capable:${candidate.id}`)
    }
    if (candidate.stage === 'production_artifact_required' && (candidate.can_predict || candidate.can_vote || candidate.vote_weight !== 0)) {
      errors.push(`artifact_required_candidate_not_fail_closed:${candidate.id}`)
    }
    if (candidate.stage === 'shadow_challenger' && (candidate.can_vote || candidate.vote_weight !== 0)) {
      errors.push(`shadow_candidate_can_vote:${candidate.id}`)
    }
    if (candidate.stage === 'meta_optimizer' && (candidate.can_predict || candidate.can_vote)) {
      errors.push(`meta_optimizer_misclassified:${candidate.id}`)
    }
    if (candidate.can_promote_directly) errors.push(`direct_promote_not_allowed:${candidate.id}`)
  }
  return { ok: errors.length === 0, errors }
}
