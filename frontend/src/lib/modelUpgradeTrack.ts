export type ModelUpgradeStage =
  | 'production_slot_member'
  | 'production_artifact_required'
  | 'shadow_challenger'
  | 'benchmark_only'
  | 'meta_optimizer'
  | 'allocator_controller'
  | 'state_space_overlay'

export type ModelUpgradeLayer =
  | 'L2 coarse'
  | 'L3 core family'
  | 'L4 allocator'
  | 'meta'
  | 'overlay'

export type ModelUpgradeCandidate = {
  id: string
  stage: ModelUpgradeStage
  family: string
  layer: ModelUpgradeLayer
  titleZh: string
  roleZh: string
  roleEn: string
  requiredEvidence: string[]
  canVote: boolean
}

export const MODEL_POOL_L2_COARSE_MODEL_IDS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
] as const

export const MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
  'TimesFM',
] as const

export const MODEL_POOL_FORMAL_L3_SLOT_IDS = MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS

export const MODEL_POOL_RETIRED_MODEL_IDS = [
  'CatBoost',
  'FT-Transformer',
  'FTTransformer',
  'Chronos',
  'Chronos2ZeroShot',
  'Chronos2LoRA',
] as const

export const MODEL_POOL_RESEARCH_SHADOW_MODEL_IDS = [
  'ResidualMLP',
] as const

// Backward-compatible export name used by Model Pool components.
export const MODEL_POOL_PRODUCTION_SLOT_IDS = MODEL_POOL_FORMAL_L3_SLOT_IDS

const CORE_ARTIFACT_EVIDENCE = [
  'production artifact',
  'verified rows',
  'OOS/live IC',
  'coverage',
  'final compare',
  'Wei approval for production effect',
]

export const MODEL_UPGRADE_CANDIDATES: ModelUpgradeCandidate[] = [
  {
    id: 'LightGBM',
    stage: 'production_slot_member',
    family: 'tree_family',
    layer: 'L2 coarse',
    titleZh: 'LightGBM L2/L3 active slot',
    roleZh: 'Tree coarse gate member and L3 tree-family alpha voter. It remains active only with artifact, verified rows, and live/OOS IC evidence.',
    roleEn: 'Tree coarse gate member and L3 tree-family alpha voter.',
    requiredEvidence: CORE_ARTIFACT_EVIDENCE,
    canVote: true,
  },
  {
    id: 'XGBoost',
    stage: 'production_slot_member',
    family: 'tree_family',
    layer: 'L2 coarse',
    titleZh: 'XGBoost L2/L3 active slot',
    roleZh: 'Tree coarse gate member and L3 tree-family alpha voter. It should not be grouped with retired CatBoost.',
    roleEn: 'Tree coarse gate member and L3 tree-family alpha voter.',
    requiredEvidence: CORE_ARTIFACT_EVIDENCE,
    canVote: true,
  },
  {
    id: 'ExtraTrees',
    stage: 'production_slot_member',
    family: 'tree_family',
    layer: 'L2 coarse',
    titleZh: 'ExtraTrees L2/L3 active slot',
    roleZh: 'Tree coarse gate member and diversity guard for the active tree family.',
    roleEn: 'Tree coarse gate member and diversity guard.',
    requiredEvidence: CORE_ARTIFACT_EVIDENCE,
    canVote: true,
  },
  {
    id: 'TabM',
    stage: 'production_slot_member',
    family: 'tabular_neural_family',
    layer: 'L3 core family',
    titleZh: 'TabM L3 active slot',
    roleZh: 'Tabular neural branch for nonlinear interactions beyond tree-family features. It can vote only after artifact, schema parity, verified rows, and positive lifecycle evidence.',
    roleEn: 'L3 tabular neural production slot.',
    requiredEvidence: ['production artifact', 'verified rows', 'schema parity', 'OOS/live IC', 'CPCV/PBO', 'slice stability'],
    canVote: true,
  },
  {
    id: 'GNN',
    stage: 'production_slot_member',
    family: 'graph_relation_family',
    layer: 'L3 core family',
    titleZh: 'GNN L3 active slot',
    roleZh: 'Cross-stock graph relation branch. It needs graph spec, leakage controls, artifact readiness, verified rows, and lifecycle IC before positive L3 weight.',
    roleEn: 'L3 graph relation production slot.',
    requiredEvidence: ['production artifact', 'verified rows', 'graph spec', 'leakage control', 'OOS/live IC', 'slice stability'],
    canVote: true,
  },
  {
    id: 'DLinear',
    stage: 'production_slot_member',
    family: 'sequence_family',
    layer: 'L3 core family',
    titleZh: 'DLinear L3 active slot',
    roleZh: 'Lightweight learned sequence baseline. It belongs to the L3 sequence family, not a separate scheduler layer.',
    roleEn: 'L3 lightweight sequence baseline.',
    requiredEvidence: CORE_ARTIFACT_EVIDENCE,
    canVote: true,
  },
  {
    id: 'PatchTST',
    stage: 'production_slot_member',
    family: 'sequence_family',
    layer: 'L3 core family',
    titleZh: 'PatchTST L3 active slot',
    roleZh: 'Patch-based learned sequence model. It votes through artifact-backed sequence evidence and verified IC.',
    roleEn: 'L3 patch-based sequence model.',
    requiredEvidence: CORE_ARTIFACT_EVIDENCE,
    canVote: true,
  },
  {
    id: 'iTransformer',
    stage: 'production_slot_member',
    family: 'sequence_family',
    layer: 'L3 core family',
    titleZh: 'iTransformer L3 active slot',
    roleZh: 'Learned transformer sequence branch. It is blocked until artifact-backed serving, verified rows, and walk-forward IC are complete.',
    roleEn: 'L3 learned sequence transformer slot.',
    requiredEvidence: ['production artifact', 'verified rows', 'walk-forward IC', 'sequence slice report', 'CPCV/PBO', 'latency cost'],
    canVote: true,
  },
  {
    id: 'TimesFM',
    stage: 'production_slot_member',
    family: 'sequence_family',
    layer: 'L3 core family',
    titleZh: 'TimesFM L3 active slot',
    roleZh: 'Foundation time-series branch. It uses forecast evidence and verified IC before receiving positive sequence-family weight.',
    roleEn: 'L3 foundation time-series production slot.',
    requiredEvidence: ['production artifact', 'verified rows', 'formal L3 slot wiring', 'forecast OOS IC', 'walk-forward', 'cost report', 'slice stability'],
    canVote: true,
  },
  {
    id: 'LinUCB',
    stage: 'shadow_challenger',
    family: 'meta_policy',
    layer: 'meta',
    titleZh: 'LinUCB production baseline',
    roleZh: 'Current production contextual bandit baseline for model weighting. Replay may audit it, but production changes still need evidence and approval.',
    roleEn: 'Production baseline contextual bandit meta-router.',
    requiredEvidence: ['reward ledger', 'walk-forward replay', 'per-arm samples', 'context coverage'],
    canVote: false,
  },
  {
    id: 'NeuralUCB',
    stage: 'shadow_challenger',
    family: 'meta_policy',
    layer: 'meta',
    titleZh: 'NeuralUCB shadow challenger',
    roleZh: 'Nonlinear shadow meta-router compared against LinUCB. It does not change production decisions.',
    roleEn: 'Shadow nonlinear meta-router.',
    requiredEvidence: ['shadow decisions', 'counterfactual rewards', 'walk-forward replay', 'regime slices'],
    canVote: false,
  },
  {
    id: 'NeuralTS',
    stage: 'shadow_challenger',
    family: 'meta_policy',
    layer: 'meta',
    titleZh: 'NeuralTS shadow challenger',
    roleZh: 'Thompson-sampling shadow challenger for uncertainty calibration. It does not change production decisions.',
    roleEn: 'Shadow Thompson-sampling meta-router.',
    requiredEvidence: ['shadow decisions', 'posterior uncertainty', 'counterfactual rewards', 'drawdown slice'],
    canVote: false,
  },
  {
    id: 'NeuCB',
    stage: 'benchmark_only',
    family: 'meta_policy',
    layer: 'meta',
    titleZh: 'NeuCB research benchmark',
    roleZh: 'Research-only neural contextual bandit benchmark until replay and registry evidence beat the current baseline.',
    roleEn: 'Research-only neural contextual bandit benchmark.',
    requiredEvidence: ['benchmark report', 'OOS reward', 'PBO', 'cost profile', 'latency'],
    canVote: false,
  },
  {
    id: 'OnlinePortfolioBandit',
    stage: 'allocator_controller',
    family: 'allocation_policy',
    layer: 'L4 allocator',
    titleZh: 'OnlinePortfolioBandit L4 allocator',
    roleZh: 'Allocator controller for sparse/SIT style portfolio decisions. It is evaluated separately from meta-policy routers.',
    roleEn: 'L4 allocation controller, separate from model-ranking policies.',
    requiredEvidence: ['execution realism', 'paper/live parity', 'slippage model', 'partial fill replay', 'drawdown'],
    canVote: false,
  },
  {
    id: 'GAOptimizer',
    stage: 'meta_optimizer',
    family: 'genetic_meta_optimizer',
    layer: 'meta',
    titleZh: 'GA optimizer',
    roleZh: 'Parameter proposal engine for ensemble, strategy, and risk knobs. It emits candidates, not alpha votes.',
    roleEn: 'Learns parameter candidates without emitting stock alpha votes.',
    requiredEvidence: ['walk-forward', 'PBO', 'MC plateau', 'transaction cost sensitivity'],
    canVote: false,
  },
  {
    id: 'KalmanFilter',
    stage: 'state_space_overlay',
    family: 'state_space',
    layer: 'overlay',
    titleZh: 'Kalman overlay',
    roleZh: 'Noise and uncertainty overlay for L4 sizing context. It is not an L3 alpha model.',
    roleEn: 'Noise smoothing and uncertainty overlay for L4 risk context.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
  {
    id: 'MarkovSwitching',
    stage: 'state_space_overlay',
    family: 'state_space',
    layer: 'overlay',
    titleZh: 'Markov switching overlay',
    roleZh: 'Market regime overlay for L4 risk context. It is not an L3 alpha model.',
    roleEn: 'Regime-state overlay for L4 risk context.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
]

export const MODEL_UPGRADE_STAGE_LABELS: Record<ModelUpgradeStage, string> = {
  production_slot_member: 'production L3 slot',
  production_artifact_required: 'production target blocked by missing artifact',
  shadow_challenger: 'shadow evidence only',
  benchmark_only: 'research benchmark',
  meta_optimizer: 'meta optimizer',
  allocator_controller: 'L4 allocator controller',
  state_space_overlay: 'state-space overlay',
}
