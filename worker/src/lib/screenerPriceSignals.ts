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

/** One FinLab adjusted bar (market.canonical_market_daily, source finlab.price). */
export interface AdjustedGapBar {
  adjHigh: number | null
  adjLow: number | null
}

/**
 * Registry tech_gap_down: today_high_adj < yesterday_low_adj, as 0/1. The two sessions are the stock's own
 * latest and previous unadjusted rows. Null when either session has no positive adjusted bar; never falls back
 * to unadjusted prices, where an ex-dividend drop reads as a gap.
 */
export function adjustedGapDown(
  barsByDate: ReadonlyMap<string, AdjustedGapBar> | undefined,
  latestDate: string | null | undefined,
  previousDate: string | null | undefined,
): number | null {
  if (!barsByDate || !latestDate || !previousDate || previousDate >= latestDate) return null
  const latestHigh = barsByDate.get(latestDate)?.adjHigh
  const previousLow = barsByDate.get(previousDate)?.adjLow
  if (latestHigh == null || previousLow == null || !(latestHigh > 0) || !(previousLow > 0)) return null
  return latestHigh < previousLow ? 1 : 0
}
