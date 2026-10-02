/** Presentation groups; dates/statuses always belong to the individual job receipts. */
export const DAILY_READINESS_PHASES = [
  { id: 'sources', title: '行情與特徵', caption: '收盤資料 → 可用特徵',
    stages: ['market-close-refresh', 'finlab-v4-backfill', 'finlab-backfill-watchdog', 'update', 'indicator-queue', 'regime-compute', 'screener', 'allocator-ev-readiness'] },
  { id: 'models', title: '模型與產物', caption: 'L3 預測與目前發布產物',
    stages: ['pipeline', 'ml-predict', 'recommendation', 'post-pipeline-chain', 'dataset-snapshot-export', 'allocator-ev-feature-snapshot-backfill'] },
  { id: 'evidence', title: '驗證與晚間收據', caption: '驗證、回饋與晚間 closure',
    stages: ['verify-v2', 'post-verify-chain', 'active8-oof-daily', 'allocator-ev-lifecycle-watchdog', 'model-ic-rolling', 'linucb-reward-ledger', 'adapt', 'daily-report', 'paper-active-postmarket', 'obsidian-sync', 'meta-learning-shadow', 'strategy-learning', 'evening-closure'] },
  { id: 'premarket', title: '盤前資料與定案', caption: 'US / News → 準備 → Pre-market',
    stages: ['us-leading', 'news-analyst', 'premarket-evidence-watchdog', 'morning-setup', 'pre-market-warmup'] },
] as const

export const PREMARKET_READINESS_IDS = new Set<string>(DAILY_READINESS_PHASES[3].stages)

export function dailyPhaseForStage(id: string) {
  return DAILY_READINESS_PHASES.find(phase => (phase.stages as readonly string[]).includes(id))?.id
}
