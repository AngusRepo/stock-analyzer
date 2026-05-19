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
    id: 'Chronos2ZeroShot',
    stage: 'production_slot_member',
    family: 'foundation_time_series',
    titleZh: 'Chronos2 Zero-shot',
    roleZh: 'Chronos production slot 內部成員，只能透過 Chronos 單一 alpha slot 貢獻，不增加模型票數分母。',
    roleEn: 'Production Chronos member; contributes through the single Chronos alpha slot.',
    requiredEvidence: ['forecast validation', 'outcome join', 'rank IC'],
    canVote: true,
  },
  {
    id: 'Chronos2LoRA',
    stage: 'production_slot_member',
    family: 'foundation_time_series_adapter',
    titleZh: 'Chronos2 LoRA',
    roleZh: 'Chronos adapter 候選，需有 adapter metadata 與 forecast validation，仍歸屬 Chronos slot。',
    roleEn: 'Optional fine-tuned Chronos member with adapter evidence.',
    requiredEvidence: ['adapter metadata', 'forecast validation', 'outcome join', 'rank IC'],
    canVote: true,
  },
  {
    id: 'ResidualMLP',
    stage: 'shadow_challenger',
    family: 'tabular_neural_shadow',
    titleZh: 'Residual MLP',
    roleZh: '用來學習 tree / FT 系列殘差的 shadow predictor；可產生 shadow evidence，但不能直接投 production 票。',
    roleEn: 'Shadow tabular residual learner; evidence only before promotion.',
    requiredEvidence: ['shadow rows', 'OOS IC', 'CPCV/PBO', 'cost profile'],
    canVote: false,
  },
  {
    id: 'GNN',
    stage: 'shadow_challenger',
    family: 'cross_stock_graph_shadow',
    titleZh: 'Cross-stock GNN',
    roleZh: '用跨股票關聯圖補足供應鏈、族群與資金流關係；promotion 前必須有 graph spec 與 leakage controls。',
    roleEn: 'Graph relation challenger; requires graph spec and leakage controls.',
    requiredEvidence: ['graph spec', 'shadow rows', 'OOS IC', 'CPCV/PBO', 'leakage controls'],
    canVote: false,
  },
  {
    id: 'TabM',
    stage: 'benchmark_only',
    family: 'tabular_deep_learning',
    titleZh: 'TabM benchmark',
    roleZh: 'Tabular deep learning 研究基準；先比較 OOS evidence 與成本，不進 production inference。',
    roleEn: 'Benchmark-only tabular deep learning candidate.',
    requiredEvidence: ['experiment registry', 'OOS IC', 'CPCV/PBO', 'cost sensitivity', 'data slice report'],
    canVote: false,
  },
  {
    id: 'iTransformer',
    stage: 'benchmark_only',
    family: 'time_series_transformer',
    titleZh: 'iTransformer benchmark',
    roleZh: 'Sequence family 研究基準，用來比較 DLinear / PatchTST / Chronos 類時間序列 evidence。',
    roleEn: 'Benchmark-only inverted time-series transformer candidate.',
    requiredEvidence: ['experiment registry', 'OOS IC', 'CPCV/PBO', 'sequence slice report', 'cost sensitivity'],
    canVote: false,
  },
  {
    id: 'TimesFM',
    stage: 'benchmark_only',
    family: 'foundation_time_series',
    titleZh: 'TimesFM benchmark',
    roleZh: 'Foundation time-series benchmark，用來和 Chronos family 比較，不直接取代 production。',
    roleEn: 'Foundation time-series benchmark against Chronos.',
    requiredEvidence: ['experiment registry', 'forecast OOS IC', 'walk-forward', 'latency/cost report'],
    canVote: false,
  },
  {
    id: 'GAOptimizer',
    stage: 'meta_optimizer',
    family: 'genetic_meta_optimizer',
    titleZh: 'GA optimizer',
    roleZh: '學習 ensemble、strategy、risk 參數；屬於 meta optimizer，不產生個股 alpha vote。',
    roleEn: 'Learns ensemble, strategy, and risk parameters without emitting stock alpha votes.',
    requiredEvidence: ['walk-forward', 'PBO', 'MC plateau', 'transaction cost sensitivity'],
    canVote: false,
  },
  {
    id: 'KalmanFilter',
    stage: 'state_space_overlay',
    family: 'state_space',
    titleZh: 'Kalman overlay',
    roleZh: '大盤與訊號 noise smoothing / uncertainty overlay；只提供 regime/risk context。',
    roleEn: 'Noise smoothing and uncertainty overlay for regime/risk context.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
  {
    id: 'MarkovSwitching',
    stage: 'state_space_overlay',
    family: 'state_space',
    titleZh: 'Markov switching overlay',
    roleZh: 'Bull / bear / volatile regime state overlay；不進 alpha vote，也不算 production model slot。',
    roleEn: 'Regime-state overlay for bull, bear, and volatile context.',
    requiredEvidence: ['overlay diagnostics', 'regime context'],
    canVote: false,
  },
]

export const MODEL_UPGRADE_STAGE_LABELS: Record<ModelUpgradeStage, string> = {
  production_slot_member: 'production slot member / 現有槽位成員',
  shadow_challenger: 'shadow challenger / 影子挑戰者',
  benchmark_only: 'benchmark only / 研究基準',
  meta_optimizer: 'meta optimizer / 參數學習器',
  state_space_overlay: 'state-space overlay / 狀態空間 overlay',
}
