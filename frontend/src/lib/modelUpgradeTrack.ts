export type ModelUpgradeStage =
  | 'layer3_formal_family_slot'
  | 'retired'
  | 'meta_optimizer'
  | 'state_space_overlay'

export type ModelUpgradeCandidate = {
  id: string
  stage: ModelUpgradeStage
  family: string
  titleZh: string
  roleZh: string
  roleEn: string
  requiredEvidence: string[]
  canVote: boolean
}

export const MODEL_UPGRADE_CANDIDATES: ModelUpgradeCandidate[] = [
  {
    id: 'TabM',
    stage: 'layer3_formal_family_slot',
    family: 'tabular_neural',
    titleZh: 'TabM formal slot',
    roleZh: 'Layer 3 tabular neural branch; replaces FT-Transformer and ResidualMLP as the formal neural tabular direction.',
    roleEn: 'Formal Layer 3 tabular-neural slot; requires artifact evidence before voting.',
    requiredEvidence: ['artifact manifest', 'feature policy', 'walk-forward', 'CPCV/PBO', 'cost profile'],
    canVote: false,
  },
  {
    id: 'GNN',
    stage: 'layer3_formal_family_slot',
    family: 'cross_stock_graph',
    titleZh: 'GNN formal slot',
    roleZh: 'Layer 3 graph branch for cross-stock relation evidence; requires leakage controls before production scoring.',
    roleEn: 'Formal Layer 3 graph slot; requires graph spec and leakage controls.',
    requiredEvidence: ['graph spec', 'leakage controls', 'artifact manifest', 'walk-forward', 'CPCV/PBO'],
    canVote: false,
  },
  {
    id: 'iTransformer',
    stage: 'layer3_formal_family_slot',
    family: 'learned_sequence',
    titleZh: 'iTransformer formal slot',
    roleZh: 'Layer 3 learned sequence branch candidate compared with PatchTST and DLinear.',
    roleEn: 'Formal Layer 3 learned-sequence slot.',
    requiredEvidence: ['sequence policy', 'artifact manifest', 'walk-forward', 'CPCV/PBO', 'cost profile'],
    canVote: false,
  },
  {
    id: 'TimesFM',
    stage: 'layer3_formal_family_slot',
    family: 'foundation_sequence',
    titleZh: 'TimesFM formal slot',
    roleZh: 'Layer 3 foundation sequence branch candidate; Chronos is retired from alpha vote.',
    roleEn: 'Formal Layer 3 foundation-sequence slot.',
    requiredEvidence: ['forecast validation', 'artifact manifest', 'walk-forward', 'PBO', 'cost profile'],
    canVote: false,
  },
  {
    id: 'ResidualMLP',
    stage: 'retired',
    family: 'tabular_neural_retired',
    titleZh: 'ResidualMLP retired',
    roleZh: 'Retired after TabM was selected for the tabular-neural branch.',
    roleEn: 'Retired neural tabular path.',
    requiredEvidence: [],
    canVote: false,
  },
  {
    id: 'FT-Transformer',
    stage: 'retired',
    family: 'tabular_neural_retired',
    titleZh: 'FT-Transformer retired',
    roleZh: 'Removed from active alpha vote, training policy, and comparator role.',
    roleEn: 'Retired tabular transformer path.',
    requiredEvidence: [],
    canVote: false,
  },
  {
    id: 'Chronos',
    stage: 'retired',
    family: 'foundation_sequence_retired',
    titleZh: 'Chronos retired',
    roleZh: 'Retired from alpha vote and evening-chain batch inference.',
    roleEn: 'Retired foundation sequence slot.',
    requiredEvidence: [],
    canVote: false,
  },
  {
    id: 'GAOptimizer',
    stage: 'meta_optimizer',
    family: 'genetic_meta_optimizer',
    titleZh: 'GA optimizer',
    roleZh: 'Learns ensemble, strategy, and risk parameters without emitting stock alpha votes.',
    roleEn: 'Meta optimizer only; no direct stock alpha vote.',
    requiredEvidence: ['walk-forward', 'PBO', 'MC plateau', 'transaction cost sensitivity'],
    canVote: false,
  },
  {
    id: 'KalmanFilter',
    stage: 'state_space_overlay',
    family: 'state_space',
    titleZh: 'Kalman overlay',
    roleZh: 'Noise smoothing and uncertainty overlay for regime/risk context.',
    roleEn: 'State-space overlay, not an alpha vote.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
  {
    id: 'MarkovSwitching',
    stage: 'state_space_overlay',
    family: 'state_space',
    titleZh: 'Markov switching overlay',
    roleZh: 'Regime-state overlay for bull, bear, and volatile context.',
    roleEn: 'State-space overlay, not an alpha vote.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
]

export const MODEL_UPGRADE_STAGE_LABELS: Record<ModelUpgradeStage, string> = {
  layer3_formal_family_slot: 'Layer 3 formal family slot',
  retired: 'retired',
  meta_optimizer: 'meta optimizer',
  state_space_overlay: 'state-space overlay',
}
