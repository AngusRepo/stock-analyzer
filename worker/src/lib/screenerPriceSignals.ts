// Pure price-signal helpers for the L1 screener raw signals (deriveStrategyRawSignals in marketScreener.ts).

export const VOLA_CV_90D_SESSIONS = 90

/**
 * Registry vola_cv_90d: std(close, 90) / mean(close, 90) on unadjusted closes, with the sample std (n - 1) of
 * pandas close.rolling(90).std() used by the FinLab reference (tools/finlab_*_backtest.py).
 * Null when fewer than 90 sessions are available or the mean is not positive.
 */
export function volaCv90dFromCloses(closes: readonly number[]): number | null {
  const window = closes.slice(-VOLA_CV_90D_SESSIONS).filter(Number.isFinite)
  if (window.length < VOLA_CV_90D_SESSIONS) return null
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length
  if (!(mean > 0)) return null
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (window.length - 1)
  return Math.sqrt(Math.max(0, variance)) / mean
}
