export type ModelUpgradeStage =
  | 'production_slot_member'
  | 'production_artifact_required'
  | 'shadow_challenger'
  | 'benchmark_only'
  | 'meta_optimizer'
  | 'state_space_overlay'

export type ModelUpgradeCandidate = {
  id: string
  stage: ModelUpgradeStage
  family: string
  layer: 'L2 coarse' | 'L3 core family' | 'L4 allocator' | 'meta' | 'overlay'
  titleZh: string
  roleZh: string
  roleEn: string
  requiredEvidence: string[]
  canVote: boolean
}

export const MODEL_POOL_RETIRED_MODEL_IDS = [
  'FT-Transformer',
  'FTTransformer',
  'Chronos',
  'Chronos2ZeroShot',
  'Chronos2LoRA',
  'ResidualMLP',
] as const

export const MODEL_POOL_PRODUCTION_SLOT_IDS = [
  'TabM',
  'GNN',
  'iTransformer',
  'TimesFM',
] as const

export const MODEL_UPGRADE_CANDIDATES: ModelUpgradeCandidate[] = [
  {
    id: 'TabM',
    stage: 'production_slot_member',
    family: 'tabular_neural_family',
    layer: 'L3 core family',
    titleZh: 'TabM L3 正式槽位',
    roleZh: 'Tabular neural branch。用來補 Tree family 不容易捕捉的非線性 tabular interaction；有 artifact、schema parity、正 IC 時可參與 ensemble_v2 family vote。',
    roleEn: 'L3 tabular neural production slot. It votes when artifact, schema parity, and positive lifecycle weight are present.',
    requiredEvidence: ['production artifact', 'OOS IC', 'CPCV/PBO', 'cost sensitivity', 'slice stability', 'serve feature parity'],
    canVote: true,
  },
  {
    id: 'GNN',
    stage: 'production_slot_member',
    family: 'graph_relation_family',
    layer: 'L3 core family',
    titleZh: 'GNN L3 正式槽位',
    roleZh: 'Cross-stock graph branch。負責股與股、族群與資金流關係；有 graph spec、leakage control、artifact 與正 IC 時可參與 L3 family vote。',
    roleEn: 'L3 graph relation production slot. It votes when graph evidence, artifact, and positive lifecycle weight are present.',
    requiredEvidence: ['production artifact', 'graph spec', 'leakage control', 'OOS IC', 'CPCV/PBO', 'slice stability'],
    canVote: true,
  },
  {
    id: 'iTransformer',
    stage: 'production_slot_member',
    family: 'sequence_transformer_family',
    layer: 'L3 core family',
    titleZh: 'iTransformer L3 正式槽位',
    roleZh: 'Learned sequence branch。與 DLinear/PatchTST 同屬時間序列 family；有 artifact-backed serving、walk-forward IC 與成本證據時可參與 L3 sequence vote。',
    roleEn: 'L3 learned sequence production slot. It votes when artifact-backed serving and positive sequence evidence are present.',
    requiredEvidence: ['production artifact', 'walk-forward IC', 'sequence slice report', 'CPCV/PBO', 'latency cost', 'serve feature parity'],
    canVote: true,
  },
  {
    id: 'TimesFM',
    stage: 'production_slot_member',
    family: 'foundation_sequence_family',
    layer: 'L3 core family',
    titleZh: 'TimesFM L3 正式槽位',
    roleZh: 'Foundation time-series branch。負責 foundation forecast evidence；有 forecast OOS IC、正式 L3 slot wiring 與成本證據時可參與 sequence family vote。',
    roleEn: 'L3 foundation time-series production slot. It votes when forecast evidence, formal L3 wiring, and positive lifecycle weight are present.',
    requiredEvidence: ['production artifact', 'forecast OOS IC', 'walk-forward', 'cost report', 'slice stability', 'formal_layer3_slots'],
    canVote: true,
  },
  {
    id: 'GAOptimizer',
    stage: 'meta_optimizer',
    family: 'genetic_meta_optimizer',
    layer: 'meta',
    titleZh: 'GA optimizer',
    roleZh: '學習 ensemble、strategy、risk 參數 proposal；不直接輸出個股 alpha vote，不直接改 production config。',
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
    roleZh: 'Noise smoothing / uncertainty overlay，提供 L4 sizing context。',
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
    roleZh: 'Bull / bear / volatile regime overlay，提供 L4 market-state context。',
    roleEn: 'Regime-state overlay for L4 risk context.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
]

export const MODEL_UPGRADE_STAGE_LABELS: Record<ModelUpgradeStage, string> = {
  production_slot_member: 'production L3 slot / 正式槽位',
  production_artifact_required: 'production target blocked / 缺 artifact',
  shadow_challenger: 'shadow research candidate / shadow evidence only',
  benchmark_only: 'research benchmark / 研究比較',
  meta_optimizer: 'meta optimizer / 參數學習',
  state_space_overlay: 'state-space overlay / 風控 overlay',
}
