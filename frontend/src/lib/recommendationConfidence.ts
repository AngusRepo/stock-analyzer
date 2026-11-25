// Display-only confidence on recommendation cards (Worker: worker/src/lib/recommendationConfidence.ts).
// The Worker attaches rec.r33_confidence and orders the payload by L4 EV; the toggle re-orders
// the same rows client-side with the same rule. Nothing here feeds a trading decision.

export const CONFIDENCE_SORT_OPTIONS = [
  { value: 'l4_ev', label: 'L4 EV', title: 'L4 預期 5 日池內超額報酬（同 EV 再以 R33 分數排序）' },
  { value: 'r33_percentile', label: '排名百分位', title: 'R33 分數在當日全池的排名百分位' },
  { value: 'win_rate', label: '校準勝率', title: 'R33 正式 OOF 擬合的 P(5 日池內超額報酬 > 0)' },
  { value: 'legacy_rank', label: '舊排名', title: '舊版選股排名（牌卡分數時代）' },
] as const
export type ConfidenceSortMode = typeof CONFIDENCE_SORT_OPTIONS[number]['value']
export const DEFAULT_CONFIDENCE_SORT: ConfidenceSortMode = 'l4_ev'

export interface PercentileConfidence {
  status: 'available' | 'unavailable'
  reason?: string | null
  value?: number
  rank?: number
  pool_size?: number
  models_positive?: number
  models_available?: number
  roster_size?: number
  definition?: string
}
export interface WinRateConfidence {
  status: 'available' | 'unavailable'
  reason?: string | null
  value?: number
  base_rate?: number
  horizon_sessions?: number
  definition?: string
  oof_start?: string | null
  oof_end?: string | null
  cohort_id?: string
}
export interface RecommendationConfidence {
  display_only?: boolean
  plan_id?: string | null
  signal_date?: string | null
  l4_expected_return?: number | null
  r33_score?: number | null
  percentile?: PercentileConfidence
  win_rate?: WinRateConfidence
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

export function confidenceFromRec(rec: any): RecommendationConfidence | null {
  const value = rec?.r33_confidence
  return value && typeof value === 'object' ? value as RecommendationConfidence : null
}

const UNAVAILABLE_REASON: Record<string, string> = {
  plan_unavailable: '當日 L4 計畫不可用',
  plan_not_found: '當日 L4 計畫不可用',
  plan_read_failed: 'L4 計畫讀取失敗',
  symbol_not_in_plan: '不在當日 L4 計畫池',
  r33_score_unavailable: '當日無 R33 分數',
  plan_cohort_mismatch: '模型 cohort 已變更，勝率表需重建',
  plan_ensemble_mismatch: '模型版本已變更，勝率表需重建',
  plan_serving_calibration_mismatch: 'EV 校準表已變更，勝率表需重建',
  l3_pointer_unavailable: 'L3 pointer 讀取失敗',
  l3_pointer_cohort_mismatch: '正式模型已切換，勝率表需重建',
}

export function confidenceUnavailableText(reason: string | null | undefined): string {
  return UNAVAILABLE_REASON[String(reason ?? '')] ?? '不可用'
}

export function percentileText(confidence: RecommendationConfidence | null): string {
  const p = confidence?.percentile
  return p?.status === 'available' && finite(p.value) != null ? `P${Math.round(Number(p.value))}` : '—'
}

export function agreementText(confidence: RecommendationConfidence | null): string | null {
  const p = confidence?.percentile
  if (p?.status !== 'available' || finite(p.models_available) == null) return null
  return `${p.models_positive ?? 0}/${p.models_available} 模型看多`
}

export function winRateText(confidence: RecommendationConfidence | null): string {
  const w = confidence?.win_rate
  return w?.status === 'available' && finite(w.value) != null ? `${(Number(w.value) * 100).toFixed(0)}%` : '不可用'
}

function sortValue(rec: any, mode: ConfidenceSortMode): number | null {
  const c = confidenceFromRec(rec)
  if (mode === 'l4_ev') return finite(c?.l4_expected_return)
  if (mode === 'r33_percentile') return finite(c?.r33_score)
  if (mode === 'win_rate') return c?.win_rate?.status === 'available' ? finite(c.win_rate.value) : null
  return null
}

/** Same rule as the Worker: descending by the mode (unavailable last), then R33 score, then legacy rank. */
export function sortByConfidence<T>(rows: T[], mode: ConfidenceSortMode): T[] {
  const legacy = (row: any) => finite(row?.rank) ?? Number.POSITIVE_INFINITY
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    if (mode !== 'legacy_rank') {
      const keys: ConfidenceSortMode[] = mode === 'r33_percentile' ? [mode] : [mode, 'r33_percentile']
      for (const key of keys) {
        const va = sortValue(a.row, key)
        const vb = sortValue(b.row, key)
        if (va == null && vb != null) return 1
        if (vb == null && va != null) return -1
        if (va != null && vb != null && va !== vb) return vb - va
      }
    }
    return legacy(a.row) - legacy(b.row) || a.index - b.index
  }).map(({ row }) => row)
}
