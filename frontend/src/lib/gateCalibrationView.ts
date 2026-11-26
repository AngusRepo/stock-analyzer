/**
 * 進場卡控摘要（/api/paper/gate-calibration）。
 * 新版 Worker（batch2 paperGateCalibration）：*_events 欄位，filled／deferred／blocked／skipped 四格，
 * total_events＝四格加總（cancelled_events 是 skipped 的子集，不另算），附 window_start／window_end／denominator_definition。
 * 查詢失敗回 503 → 前端顯示讀取失敗，不是「尚無」。
 * 舊版 Worker：沒有 blocked／window，且 deferred／skipped 字彙對不上會恆為 0——
 * 四格加總 ≠ total 時標「口徑不一致」，不把誤導的 0 當成真的。
 */
export type GateBucketKey = 'filled' | 'deferred' | 'blocked' | 'skipped'
export interface GateBucket { key: GateBucketKey; label: string; value: number | null }
export interface GateCalibrationView {
  total: number
  buckets: GateBucket[]
  hasBlocked: boolean
  consistent: boolean
  windowLabel: string | null
  days: number
  denominatorDefinition: string | null
}

function count(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const LABELS: Record<GateBucketKey, string> = { filled: '成交', deferred: '等待', blocked: '擋單', skipped: '略過' }

export function gateCalibrationView(data: any, fallbackDays = 7): GateCalibrationView {
  const total = count(data?.total_events) ?? 0
  const blocked = count(data?.blocked_events ?? data?.blocked)
  const hasBlocked = blocked != null
  const keys: GateBucketKey[] = hasBlocked ? ['filled', 'deferred', 'blocked', 'skipped'] : ['filled', 'deferred', 'skipped']
  const raw: Record<GateBucketKey, number | null> = {
    filled: count(data?.filled_events ?? data?.filled),
    deferred: count(data?.deferred_events ?? data?.deferred),
    blocked,
    skipped: count(data?.skipped_events ?? data?.skipped),
  }
  const sum = keys.reduce((acc, key) => acc + (raw[key] ?? 0), 0)
  const consistent = total === 0 || sum === total
  const buckets = keys.map((key) => ({ key, label: LABELS[key], value: consistent ? raw[key] ?? 0 : null }))
  const start = typeof data?.window_start === 'string' ? data.window_start.slice(5, 10) : null
  const end = typeof data?.window_end === 'string' ? data.window_end.slice(5, 10) : null
  const days = count(data?.days) ?? fallbackDays
  return {
    total,
    buckets,
    hasBlocked,
    consistent,
    windowLabel: start && end ? `${start}～${end}` : null,
    days,
    denominatorDefinition: typeof data?.denominator_definition === 'string' ? data.denominator_definition : null,
  }
}
