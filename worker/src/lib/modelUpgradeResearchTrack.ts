import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export type ModelUpgradeStage =
  | 'layer3_formal_family_slot'
  | 'retired'
  | 'meta_optimizer'
  | 'state_space_overlay'

export type ModelUpgradeCandidateId =
  | 'TabM'
  | 'GNN'
  | 'iTransformer'
  | 'TimesFM'
  | 'ResidualMLP'
  | 'Chronos'
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

export const P7_MODEL_UPGRADE_TRACK_VERSION = 'p7-model-upgrade-track-v2'

export const P7_MODEL_UPGRADE_CANDIDATES: readonly ModelUpgradeCandidate[] = [
  {
    id: 'TabM',
    stage: 'layer3_formal_family_slot',
    parent_slot: 'Layer3.CoreFamily.TabularNeural',
    family: 'tabular_neural',
    role: 'formal Layer 3 tabular-neural family slot; replaces retired wide-tabular neural paths as the neural tabular direction',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['artifact_manifest', 'feature_policy', 'walk_forward', 'pbo', 'cpcv', 'cost_profile'],
    notes: 'No production vote until a reviewed artifact is registered and promoted. This is a formal slot, not a shadow/challenger bucket.',
  },
  {
    id: 'GNN',
    stage: 'layer3_formal_family_slot',
    parent_slot: 'Layer3.CoreFamily.Graph',
    family: 'cross_stock_graph',
    role: 'formal Layer 3 graph family slot for cross-stock relation evidence',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['graph_spec', 'leakage_controls', 'artifact_manifest', 'walk_forward', 'pbo', 'cpcv'],
    notes: 'Graph inference must prove relation construction and leakage controls before production scoring.',
  },
  {
    id: 'iTransformer',
    stage: 'layer3_formal_family_slot',
    parent_slot: 'Layer3.CoreFamily.LearnedSequence',
    family: 'learned_sequence',
    role: 'formal Layer 3 learned-sequence candidate to compare with PatchTST and DLinear',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['sequence_policy', 'artifact_manifest', 'walk_forward', 'pbo', 'cpcv', 'cost_profile'],
    notes: 'Eligible for the learned sequence branch after artifact promotion; evaluated as a formal family slot.',
  },
  {
    id: 'TimesFM',
    stage: 'layer3_formal_family_slot',
    parent_slot: 'Layer3.CoreFamily.FoundationSequence',
    family: 'foundation_sequence',
    role: 'formal Layer 3 foundation-sequence candidate to compare with DLinear, PatchTST, and iTransformer',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: true,
    evidence_required: ['forecast_validation', 'artifact_manifest', 'walk_forward', 'pbo', 'cost_profile'],
    notes: 'Chronos is retired from alpha vote; TimesFM belongs to the sequence-family promotion lane, not a Chronos comparator lane.',
  },
  {
    id: 'ResidualMLP',
    stage: 'retired',
    family: 'tabular_neural_retired',
    role: 'retired neural tabular path replaced by TabM',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: false,
    evidence_required: [],
    notes: 'Kept only as historical audit context; no new production or evaluation lane should be seeded.',
  },
  {
    id: 'Chronos',
    stage: 'retired',
    family: 'foundation_sequence_retired',
    role: 'retired foundation sequence slot removed from alpha vote and evening-chain batch inference',
    vote_weight: 0,
    can_predict: false,
    can_vote: false,
    can_promote_directly: false,
    requires_review_packet: false,
    evidence_required: [],
    notes: 'Use DLinear, PatchTST, iTransformer, and TimesFM for the sequence-family roadmap.',
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
    notes: 'GA belongs to proposal/evidence generation for AlphaAgentEvo and adaptive params, not direct production mutation.',
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
    `P7 Model Upgrade Track: ${P7_MODEL_UPGRADE_TRACK_VERSION}`,
    'Rules: formal Layer 3 slots require artifact promotion before voting; retired models do not seed new experiments; GA is meta-only; Kalman/Markov are overlays.',
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
    if (candidate.stage === 'layer3_formal_family_slot' && (!candidate.parent_slot || !candidate.requires_review_packet)) {
      errors.push(`formal_slot_missing_gate:${candidate.id}`)
    }
    if (candidate.stage === 'retired' && (candidate.can_predict || candidate.can_vote || candidate.vote_weight !== 0 || candidate.requires_review_packet)) {
      errors.push(`retired_candidate_still_active:${candidate.id}`)
    }
    if (candidate.stage === 'meta_optimizer' && (candidate.can_predict || candidate.can_vote)) {
      errors.push(`meta_optimizer_misclassified:${candidate.id}`)
    }
    if (candidate.stage === 'state_space_overlay' && (candidate.can_vote || candidate.vote_weight !== 0)) {
      errors.push(`overlay_counted_as_alpha_vote:${candidate.id}`)
    }
    if (candidate.can_promote_directly) errors.push(`direct_promote_not_allowed:${candidate.id}`)
  }
  return { ok: errors.length === 0, errors }
}
