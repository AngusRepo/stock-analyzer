/** Presentation groups; dates/statuses always belong to the individual job receipts. */
export const DAILY_READINESS_PHASES = [
  { id: 'sources', title: '行情與特徵', caption: '收盤資料 → 指標／風險品質 → HMM → 成熟策略證據 → 初篩',
    stages: ['market-close-refresh', 'finlab-v4-backfill', 'finlab-backfill-watchdog', 'update', 'indicator-queue', 'regime-compute', 'strategy-learning-mature-evidence', 'screener', 'allocator-ev-readiness'] },
  { id: 'models', title: '模型與產物', caption: 'Pipeline 包含資料準備、L3 預測與次日 L4；各子階段依自己的收據顯示',
    stages: ['pipeline', 'ml-predict', 'post-pipeline-chain', 'dataset-snapshot-export', 'allocator-ev-feature-snapshot-backfill'] },
  { id: 'evidence', title: '驗證與晚間收據', caption: '驗證、回饋與晚間 closure',
    stages: ['verify-v2', 'post-verify-chain', 'active8-oof-daily', 'allocator-ev-lifecycle-watchdog', 'model-ic-rolling', 'linucb-reward-ledger', 'adapt', 'daily-report', 'paper-active-postmarket', 'obsidian-sync', 'meta-learning-shadow', 'strategy-learning', 'evening-closure'] },
  { id: 'premarket', title: '盤前資料與定案', caption: '資料就緒後事件接續：US / News → Setup（最早 07:15）→ Pipeline 內 L4 推薦 → Pending buys',
    stages: ['us-leading', 'news-analyst', 'morning-setup', 'recommendation', 'pre-market-warmup', 'premarket-evidence-watchdog'] },
] as const

export const PREMARKET_READINESS_IDS = new Set<string>(DAILY_READINESS_PHASES[3].stages)

export function dailyPhaseForStage(id: string) {
  return DAILY_READINESS_PHASES.find(phase => (phase.stages as readonly string[]).includes(id))?.id
}
