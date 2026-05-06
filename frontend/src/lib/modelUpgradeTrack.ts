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
  titleZh: string
  roleZh: string
  roleEn: string
  requiredEvidence: string[]
  canVote: boolean
}

export const MODEL_UPGRADE_CANDIDATES: ModelUpgradeCandidate[] = [
  {
    id: 'ResidualMLP',
    stage: 'shadow_challenger',
    family: 'tabular_neural_shadow',
    titleZh: '殘差 MLP',
    roleZh: '補 tree/FT 沒抓到的表格殘差信號，先 shadow predict，不直接投票。',
    roleEn: 'Shadow tabular residual learner; evidence only before promotion.',
    requiredEvidence: ['shadow rows', 'OOS IC', 'CPCV/PBO', 'cost profile'],
    canVote: false,
  },
  {
    id: 'GNN',
    stage: 'shadow_challenger',
    family: 'cross_stock_graph_shadow',
    titleZh: '跨股票圖模型',
    roleZh: '用產業、題材、資金流關係驗證 cross-stock graph alpha，先不進 production vote。',
    roleEn: 'Graph relation challenger; requires graph spec and leakage controls.',
    requiredEvidence: ['graph spec', 'shadow rows', 'OOS IC', 'CPCV/PBO', 'leakage controls'],
    canVote: false,
  },
  {
    id: 'TabM',
    stage: 'benchmark_only',
    family: 'tabular_deep_learning',
    titleZh: '表格深度學習基準',
    roleZh: '研究 TabM 是否比現有 tabular family 有更穩定 OOS evidence。',
    roleEn: 'Benchmark-only tabular deep learning candidate.',
    requiredEvidence: ['experiment registry', 'OOS IC', 'CPCV/PBO', 'cost sensitivity', 'data slice report'],
    canVote: false,
  },
  {
    id: 'iTransformer',
    stage: 'benchmark_only',
    family: 'time_series_transformer',
    titleZh: '反轉式時間序列 Transformer',
    roleZh: '研究 sequence family 是否能改善 DLinear/PatchTST 的時序表現。',
    roleEn: 'Benchmark-only inverted time-series transformer candidate.',
    requiredEvidence: ['experiment registry', 'OOS IC', 'CPCV/PBO', 'sequence slice report', 'cost sensitivity'],
    canVote: false,
  },
  {
    id: 'TimesFM',
    stage: 'benchmark_only',
    family: 'foundation_time_series',
    titleZh: '時間序列 foundation benchmark',
    roleZh: '拿來和 Chronos family 做 foundation model 對照，不直接替換 production。',
    roleEn: 'Foundation time-series benchmark against Chronos.',
    requiredEvidence: ['experiment registry', 'forecast OOS IC', 'walk-forward', 'latency/cost report'],
    canVote: false,
  },
]

export const MODEL_UPGRADE_STAGE_LABELS: Record<ModelUpgradeStage, string> = {
  production_slot_member: 'production slot / production 成員',
  shadow_challenger: 'shadow challenger / 影子挑戰者',
  benchmark_only: 'benchmark only / 研究基準',
  meta_optimizer: 'meta optimizer / 參數優化器',
  state_space_overlay: 'state-space overlay / 狀態空間 overlay',
}
