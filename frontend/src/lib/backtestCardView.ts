/** 回測卡的門檻判斷與回撤格式（BotDashboard BacktestCard 用）。 */
export type ThresholdTone = 'ok' | 'fail' | 'na'

/** 有值才判斷通過／未通過；缺值（null／undefined／NaN）是「尚未檢查」，用 --na，不能標成未通過。 */
export function thresholdTone(value: number | null | undefined, min: number): ThresholdTone {
  if (value == null || !Number.isFinite(value)) return 'na'
  return value > min ? 'ok' : 'fail'
}

/** 回撤一律帶負號（同一張卡兩處格式一致）；缺值為「—」。 */
export function formatDrawdownPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `-${(Math.abs(value) * 100).toFixed(digits)}%`
}
