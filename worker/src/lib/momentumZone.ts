/**
 * momentumZone.ts — Momentum Crash Zone Detection
 *
 * Tracks daily snapshots of the screener candidate pool's momentum-crowding
 * state, then classifies the current day via percentile rank against the
 * rolling 36-month distribution:
 *
 *   zone = RED    if rank <  P10   (historically crowded → momentum-crash risk)
 *   zone = YELLOW if rank <  P30
 *   zone = GREEN  otherwise
 *
 * Consumed by paper.ts morning-setup circuit-breaker Layer 6, which scales
 * maxPositionPct by RED=0.3 / YELLOW=0.7 / GREEN=1.0.
 *
 * Reference (primary):
 *   Daniel, K. & Moskowitz, T.J. (2016). "Momentum Crashes."
 *   Journal of Financial Economics 122(2), 221-247.
 *
 * Supporting:
 *   Barroso, P. & Santa-Clara, P. (2015). "Momentum has its moments."
 *   JFE 116(1), 111-120.  Volatility-scaled momentum → Sharpe 0.5 → 0.97.
 *
 *   Cooper, M., Gutierrez, R., Hameed, A. (2004). "Market States and Momentum."
 *   Journal of Finance 59(3), 1345-1365.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type MomentumZone = 'RED' | 'YELLOW' | 'GREEN'

export interface CandidateIndicator {
  /** Mean of 5-day return across candidates (fraction). */
  avg_5d_return: number
  /** Fraction of candidates with RSI<30 OR price<MA20. [0,1] */
  pct_oversold: number
  /** Fraction of candidates with RSI>70. [0,1] */
  pct_overbought: number
  /** Mean distance below 52-week high (fraction, e.g. 0.12 = 12% below). */
  avg_dist_from_high: number
  /** Advance/decline-weighted breadth score in [-1, 1]. */
  breadth_score: number
  /** Number of candidates used for the aggregate. */
  candidate_count: number
}

export interface ZoneAssessment {
  zone: MomentumZone
  percentile_rank: number
  n_history: number
  reason: string
}

// ── Thresholds (config-free for now; tune via DB migration if needed) ───────

/** Percentile below which we flag RED (historical extreme crowding). */
export const RED_PERCENTILE = 0.10
/** Percentile below which we flag YELLOW (moderately crowded). */
export const YELLOW_PERCENTILE = 0.30
/** Rolling history window (months). Daniel & Moskowitz use 24-36 months. */
export const HISTORY_MONTHS = 36
/** Minimum history points required to trust the percentile; below → GREEN default. */
export const MIN_HISTORY = 60

/** Position-size multiplier per zone (consumed by circuit breaker Layer 6). */
export const ZONE_MULTIPLIER: Record<MomentumZone, number> = {
  RED: 0.3,
  YELLOW: 0.7,
  GREEN: 1.0,
}

// ── Percentile computation ──────────────────────────────────────────────────

/**
 * Compute the percentile rank of `value` within `history` using the
 * "mean" method (midrank) to handle ties smoothly.
 *
 * Returns a number in [0, 1]. 0 = value is smallest; 1 = value is largest.
 * Lower rank on pct_oversold = current pool is more crowded (all candidates
 * are beaten down) = historically extreme = RED light.
 *
 * Wait — that's backwards. Let me fix the semantics:
 *
 *   Higher pct_oversold = more crowded on the losing side = historical
 *   high = RIGHT tail = rank ≈ 1.0. But this is the "bounce setup" scenario,
 *   not the "crash" scenario.
 *
 *   Daniel & Moskowitz's finding: momentum crashes happen in bear-market
 *   rebounds, when oversold losers (short-side of momentum) rally hard.
 *   For a long-only system, this means: when the screener pool is
 *   HEAVILY oversold (OS% near its historical HIGH), the probability of
 *   a violent mean-reversion rally is elevated → we under-size to avoid
 *   buying into the gap-up exhaustion.
 *
 *   So RED = high pct_oversold percentile (near P90+ historically), not low.
 *   We measure rank from the top: rank_from_top = 1 - rank.
 *   RED when rank_from_top < 0.10  ⇔  rank > 0.90.
 *
 * To keep the config simple and match KFlux's "< P10 = RED" language,
 * we invert: callers pass the metric as "overboughtness" (higher=more risky),
 * and we report rank as "how many historical days were MORE risky than today".
 * If today is MORE risky than 90% of history → rank = 0.10 → RED.
 */
export function percentileRank(value: number, history: readonly number[]): number {
  if (history.length === 0) return 1.0 // no history → assume safe
  let below = 0
  let equal = 0
  for (const h of history) {
    if (h < value) below++
    else if (h === value) equal++
  }
  // Midrank for ties
  return (below + equal / 2) / history.length
}

/**
 * Assess current momentum zone.
 *
 * We use **pct_oversold** as the primary crowding metric (higher = more
 * crowded = higher rally-exhaustion / crash risk). `rank_from_top` is the
 * fraction of historical days that were LESS oversold than today:
 *
 *   rank_from_top = 1 - percentileRank(today, history)
 *
 *   RED    if rank_from_top < RED_PERCENTILE     (today is in top 10% most-crowded)
 *   YELLOW if rank_from_top < YELLOW_PERCENTILE  (today in top 30%)
 *   GREEN  otherwise
 *
 * With insufficient history (< MIN_HISTORY), default to GREEN and note reason.
 */
export function assessZone(
  todayMetric: number,
  history: readonly number[],
): ZoneAssessment {
  if (history.length < MIN_HISTORY) {
    return {
      zone: 'GREEN',
      percentile_rank: 1.0,
      n_history: history.length,
      reason: `insufficient_history (${history.length}<${MIN_HISTORY})`,
    }
  }
  const rank = percentileRank(todayMetric, history)
  const rankFromTop = 1 - rank

  let zone: MomentumZone
  let reason: string
  if (rankFromTop < RED_PERCENTILE) {
    zone = 'RED'
    reason = `crowded_top_${(RED_PERCENTILE * 100).toFixed(0)}pct (rank ${(rank * 100).toFixed(1)})`
  } else if (rankFromTop < YELLOW_PERCENTILE) {
    zone = 'YELLOW'
    reason = `crowded_top_${(YELLOW_PERCENTILE * 100).toFixed(0)}pct (rank ${(rank * 100).toFixed(1)})`
  } else {
    zone = 'GREEN'
    reason = `normal (rank ${(rank * 100).toFixed(1)})`
  }

  return {
    zone,
    percentile_rank: Number(rank.toFixed(4)),
    n_history: history.length,
    reason,
  }
}

// ── DB I/O ──────────────────────────────────────────────────────────────────

/**
 * Load historical pct_oversold values for percentile comparison.
 * Returns the last `HISTORY_MONTHS` months of data (excluding today).
 */
export async function loadOversoldHistory(
  db: D1Database,
  today: string,
): Promise<number[]> {
  try {
    const { results } = await db.prepare(`
      SELECT pct_oversold
        FROM screener_momentum_snapshots
       WHERE date < ?
         AND date >= date(?, '-${HISTORY_MONTHS} months')
         AND pct_oversold IS NOT NULL
       ORDER BY date DESC
    `).bind(today, today).all<{ pct_oversold: number }>()
    return (results ?? []).map(r => Number(r.pct_oversold))
  } catch (e) {
    console.warn('[MomentumZone] loadOversoldHistory failed (table may not exist yet):', e)
    return []
  }
}

/**
 * Write today's snapshot with computed zone + percentile rank.
 * Overwrites any existing row for the same date (idempotent).
 */
export async function writeMomentumSnapshot(
  db: D1Database,
  date: string,
  indicator: CandidateIndicator,
  assessment: ZoneAssessment,
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO screener_momentum_snapshots (
        date, candidate_count, avg_5d_return, pct_oversold, pct_overbought,
        avg_dist_from_high, breadth_score, percentile_rank, zone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        candidate_count    = excluded.candidate_count,
        avg_5d_return      = excluded.avg_5d_return,
        pct_oversold       = excluded.pct_oversold,
        pct_overbought     = excluded.pct_overbought,
        avg_dist_from_high = excluded.avg_dist_from_high,
        breadth_score      = excluded.breadth_score,
        percentile_rank    = excluded.percentile_rank,
        zone               = excluded.zone
    `).bind(
      date,
      indicator.candidate_count,
      indicator.avg_5d_return,
      indicator.pct_oversold,
      indicator.pct_overbought,
      indicator.avg_dist_from_high,
      indicator.breadth_score,
      assessment.percentile_rank,
      assessment.zone,
    ).run()
  } catch (e) {
    console.error('[MomentumZone] writeMomentumSnapshot failed:', e)
  }
}

/**
 * Read the most recent zone from DB (for circuit-breaker consumers).
 * Returns GREEN default if table empty or query fails.
 */
export async function readCurrentZone(
  db: D1Database,
): Promise<{ zone: MomentumZone; date: string | null; percentile_rank: number | null }> {
  try {
    const row = await db.prepare(`
      SELECT date, zone, percentile_rank
        FROM screener_momentum_snapshots
       ORDER BY date DESC
       LIMIT 1
    `).first<{ date: string; zone: string; percentile_rank: number }>()
    if (!row) return { zone: 'GREEN', date: null, percentile_rank: null }
    const validZones = new Set(['RED', 'YELLOW', 'GREEN'])
    const rawZone = (row.zone ?? '').toUpperCase()
    if (!validZones.has(rawZone)) {
      console.warn(`[MomentumZone] corrupt zone value "${row.zone}" in DB (date=${row.date}); defaulting to GREEN`)
    }
    const z: MomentumZone = (rawZone === 'RED' || rawZone === 'YELLOW') ? rawZone : 'GREEN'
    return { zone: z, date: row.date, percentile_rank: row.percentile_rank ?? null }
  } catch (e) {
    console.warn('[MomentumZone] readCurrentZone failed:', e)
    return { zone: 'GREEN', date: null, percentile_rank: null }
  }
}

// ── Aggregation from price history (used by screener) ──────────────────────

/**
 * Flexible bar shape: accepts both {high, low} and {max, min} (FMStockPrice)
 * so the aggregator works with any of our internal price types.
 */
interface PriceBar {
  date: string
  open?: number
  close: number
  high?: number
  low?: number
  max?: number
  min?: number
  volume?: number
}

/** Resolve high/low from either (high|max) and (low|min). */
function barHigh(b: PriceBar): number | undefined {
  return b.high ?? b.max
}

/** Simple moving average over the last `window` closes; NaN if not enough data. */
function sma(bars: readonly PriceBar[], window: number): number {
  if (bars.length < window) return NaN
  const slice = bars.slice(-window)
  let sum = 0
  for (const b of slice) sum += b.close
  return sum / window
}

/**
 * Aggregate candidate price histories into a single CandidateIndicator.
 *
 * Accepts a Map<symbol, bars> keyed by the screener's candidate list.
 * Computes, across the candidate pool:
 *   - avg_5d_return:  mean of (close[t] / close[t-5] - 1)
 *   - pct_oversold:   fraction with close < SMA(20) AND ret_5d < 0
 *   - pct_overbought: fraction with close > 1.05 × SMA(20)
 *   - avg_dist_from_high: mean of max(0, (high_252 - close) / high_252)
 *   - breadth_score:  (up - down) / (up + down) using 5d returns
 *
 * Self-contained (uses only price bars, no RSI/TI join).
 */
export function aggregateFromPrices(
  candidates: ReadonlyArray<{ symbol: string }>,
  pricesBySymbol: ReadonlyMap<string, readonly PriceBar[]>,
): CandidateIndicator {
  const n = candidates.length
  if (n === 0) {
    return {
      avg_5d_return: 0, pct_oversold: 0, pct_overbought: 0,
      avg_dist_from_high: 0, breadth_score: 0, candidate_count: 0,
    }
  }

  let sumRet = 0, cntRet = 0
  let sumDist = 0, cntDist = 0
  let nOS = 0, nOB = 0
  let nUp = 0, nDown = 0
  let contributed = 0

  for (const c of candidates) {
    const bars = pricesBySymbol.get(c.symbol)
    if (!bars || bars.length < 6) continue
    const last = bars[bars.length - 1]
    const five = bars[bars.length - 6]
    if (last?.close == null || five?.close == null || five.close <= 0) continue
    contributed++

    const ret5 = last.close / five.close - 1
    sumRet += ret5
    cntRet++
    if (ret5 > 0) nUp++
    else if (ret5 < 0) nDown++

    const ma20 = sma(bars, 20)
    const isOS = Number.isFinite(ma20) && last.close < ma20 && ret5 < 0
    const isOB = Number.isFinite(ma20) && last.close > ma20 * 1.05
    if (isOS) nOS++
    if (isOB) nOB++

    // 52-week high (≈ 252 trading days); fall back to available history.
    const lookback = bars.slice(-252)
    let hi = 0
    for (const b of lookback) {
      const h = barHigh(b) ?? b.close
      if (h != null && h > hi) hi = h
    }
    if (hi > 0) {
      sumDist += Math.max(0, (hi - last.close) / hi)
      cntDist++
    }
  }

  const avgRet = cntRet > 0 ? sumRet / cntRet : 0
  const avgDist = cntDist > 0 ? sumDist / cntDist : 0
  const pctOS = contributed > 0 ? nOS / contributed : 0
  const pctOB = contributed > 0 ? nOB / contributed : 0
  const breadth = (nUp + nDown) > 0 ? (nUp - nDown) / (nUp + nDown) : 0

  return {
    avg_5d_return: Number(avgRet.toFixed(6)),
    pct_oversold: Number(pctOS.toFixed(4)),
    pct_overbought: Number(pctOB.toFixed(4)),
    avg_dist_from_high: Number(avgDist.toFixed(6)),
    breadth_score: Number(breadth.toFixed(4)),
    candidate_count: contributed,
  }
}
