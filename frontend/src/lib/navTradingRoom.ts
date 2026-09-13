import type { PairedNavShadowReadModel } from './pipelineMaturityContract'
export type { NavAccountView, NavComparisonDetail, NavFillView } from '../../../worker/src/lib/navTradingRoomContract'
export const navNumber = (n: number | null | undefined, digits = 0) => n == null || !Number.isFinite(n)
  ? '尚無可驗證數值' : n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })
export const navPercent = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '尚無可驗證數值' : `${navNumber(n * 100, 2)}%`
export const navSign = (n: number | null | undefined) => n == null || !Number.isFinite(n) || n === 0
  ? 'text-slate-200' : n > 0 ? 'text-emerald-300' : 'text-red-300'
export function comparisonTitle(pair: PairedNavShadowReadModel['pairs'][number]) {
  const ownerLabels: Record<string, string> = { l4_alpha_ev: 'L4 base EV', allocator_ev_fusion: 'L4+ 殘差增量', ensemble: 'L3 ML ensemble' }
  const owner = ownerLabels[pair.comparison?.owner ?? ''] ?? pair.comparison?.owner ?? '未標記 owner'
  const labels: Record<string, string> = { incremental_layer: '增量比較（基準為凍結 L4）', incumbent_replacement: '現行替換比較',
    route_policy_contrast: '路由比較', allocator_policy_contrast: '配置比較', atomic_strategy_replacement: '策略替換比較' }
  return `${owner} · ${labels[pair.comparison?.kind ?? ''] ?? '比較對象待確認'} · ${pair.pair_id.slice(0, 8)}${pair.lifecycle ? ' · 已封存' : ''}`
}
