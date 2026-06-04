export type ModelUpgradeStage =
  | 'production_slot_member'
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

export const MODEL_POOL_NEAR_PRODUCTION_IDS = [
  'TabM',
  'GNN',
  'iTransformer',
  'TimesFM',
] as const

export const MODEL_UPGRADE_CANDIDATES: ModelUpgradeCandidate[] = [
  {
    id: 'TabM',
    stage: 'shadow_challenger',
    family: 'tabular_neural_family',
    layer: 'L3 core family',
    titleZh: 'TabM 正式 L3 候選',
    roleZh: 'Tabular neural branch，用來補 tree family 對非線性 tabular interaction 的盲點；通過 evidence gate 後才可拿到 ensemble_v2 正式權重。',
    roleEn: 'Near-production tabular neural family candidate for L3 core ranking.',
    requiredEvidence: ['OOS IC', 'CPCV/PBO', 'cost sensitivity', 'slice stability', 'serve feature parity'],
    canVote: false,
  },
  {
    id: 'GNN',
    stage: 'shadow_challenger',
    family: 'graph_relation_family',
    layer: 'L3 core family',
    titleZh: 'GNN 正式 L3 候選',
    roleZh: 'Cross-stock graph branch，負責族群、供應鏈、共同籌碼與關聯傳導訊號；需證明 graph spec 與 leakage control 才能進正式權重。',
    roleEn: 'Near-production graph relation family candidate for L3 core ranking.',
    requiredEvidence: ['graph spec', 'leakage control', 'OOS IC', 'CPCV/PBO', 'slice stability'],
    canVote: false,
  },
  {
    id: 'iTransformer',
    stage: 'shadow_challenger',
    family: 'sequence_transformer_family',
    layer: 'L3 core family',
    titleZh: 'iTransformer 正式 L3 候選',
    roleZh: 'Learned sequence branch，用來比較 DLinear / PatchTST 後的時間序列排序增益；重點是 walk-forward IC 與延遲成本。',
    roleEn: 'Near-production learned sequence transformer candidate.',
    requiredEvidence: ['walk-forward IC', 'sequence slice report', 'CPCV/PBO', 'latency cost', 'serve feature parity'],
    canVote: false,
  },
  {
    id: 'TimesFM',
    stage: 'shadow_challenger',
    family: 'foundation_sequence_family',
    layer: 'L3 core family',
    titleZh: 'TimesFM 正式 L3 候選',
    roleZh: 'Foundation time-series branch，用來補短期價格路徑與跨週期 forecast evidence；需證明比現有 sequence branch 有增量。',
    roleEn: 'Near-production foundation sequence candidate for L3 core ranking.',
    requiredEvidence: ['forecast OOS IC', 'walk-forward', 'cost report', 'slice stability', 'formal_layer3_slots'],
    canVote: false,
  },
  {
    id: 'GAOptimizer',
    stage: 'meta_optimizer',
    family: 'genetic_meta_optimizer',
    layer: 'meta',
    titleZh: 'GA optimizer',
    roleZh: '只學 ensemble、strategy、risk 參數 proposal；不產生股票 alpha 票，也不直接改 production config。',
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
    roleZh: 'Noise smoothing / uncertainty overlay，只給 L4 風控與 sizing context。',
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
    roleZh: 'Bull / bear / volatile regime overlay，只給 L4 風控與 market-state context。',
    roleEn: 'Regime-state overlay for L4 risk context.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
]

export const MODEL_UPGRADE_STAGE_LABELS: Record<ModelUpgradeStage, string> = {
  production_slot_member: 'production member / 正式槽位成員',
  shadow_challenger: 'near-production candidate / 近 production 候選',
  benchmark_only: 'research benchmark / 研究比較',
  meta_optimizer: 'meta optimizer / 參數學習',
  state_space_overlay: 'state-space overlay / 風控 overlay',
}
