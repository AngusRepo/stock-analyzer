import { expandFinlabStages } from '@/lib/finlabStageCards'
/** Presentation groups; dates/statuses always belong to the individual job receipts. */
export const DAILY_READINESS_PHASES = [
  { id: 'sources', title: '行情與特徵', caption: '收盤資料 → 指標／風險品質 → HMM → 成熟策略證據 → 初篩',
    stages: ['market-close-refresh', ...expandFinlabStages('finlab-v4-backfill'), 'finlab-backfill-watchdog', 'update', 'indicator-queue', 'regime-compute', 'strategy-learning-mature-evidence', 'screener', 'allocator-ev-readiness'] },
  { id: 'models', title: '夜間 L3 預測', caption: 'Pipeline 準備 → L3 封存；L4 留待次交易日盤前接續',
    stages: ['pipeline', 'ml-predict', 'dataset-snapshot-export', 'allocator-ev-feature-snapshot-backfill'] },
  { id: 'premarket', title: '盤前資料與定案', caption: '資料就緒後事件接續：US / News → Setup（最早 07:15）→ Pipeline 內 L4 推薦 → Pending buys',
    stages: ['us-leading', 'news-analyst', 'morning-setup', 'recommendation', 'pre-market-warmup', 'premarket-evidence-watchdog'] },
  { id: 'evidence', title: '驗證與收尾', caption: 'L4 callback → 驗證 → 回饋與 closure；收據仍歸屬原業務日',
    stages: ['post-pipeline-chain', 'verify-v2', 'post-verify-chain', 'active8-oof-daily', 'allocator-ev-lifecycle-watchdog', 'model-ic-rolling', 'linucb-reward-ledger', 'adapt', 'daily-report', 'paper-active-postmarket', 'obsidian-sync', 'meta-learning-shadow', 'strategy-learning', 'evening-closure'] },
] as const

export const PREMARKET_READINESS_IDS = new Set<string>(DAILY_READINESS_PHASES.find(phase => phase.id === 'premarket')!.stages)

/** Display lanes describe triggers, not a new scheduler or inferred success. */
export const READINESS_MAIN_STAGES: Record<string, readonly string[]> = {
  sources: ['market-close-refresh', ...expandFinlabStages('finlab-v4-backfill'), 'update', 'indicator-queue', 'regime-compute', 'strategy-learning-mature-evidence', 'screener'],
  models: ['pipeline', 'ml-predict'],
  premarket: ['us-leading', 'news-analyst', 'morning-setup', 'recommendation', 'pre-market-warmup'],
  evidence: ['post-pipeline-chain', 'verify-v2', 'post-verify-chain', 'strategy-learning', 'evening-closure'],
}


export function dailyPhaseForStage(id: string) {
  return DAILY_READINESS_PHASES.find(phase => (phase.stages as readonly string[]).includes(id))?.id
}
