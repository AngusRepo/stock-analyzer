/**
 * screenerPercentile.ts — P2#25 Screener Continuous Percentile Scoring
 *
 * Replace hardcoded grading rules with percentile ranking.
 * Each factor's percentile in universe × max score = smooth, fair scoring.
 *
 * Liquidity bucket (30 pts) uses 5-factor composite:
 *   1. ADTV (log-scaled) — absolute tradability        [10 pts]
 *   2. Amihud illiquidity — price impact per $traded    [9 pts]
 *   3. Turnover rate — volume / shares outstanding      [6 pts]
 *   4. Volume consistency — 1/(1+CV), lower CV = better [3 pts]
 *   5. Spread proxy — (high-low)/close, lower = better  [2 pts]
 *
 * Reference: Amihud (2002 JFM), Corwin-Schultz (2012)
 */

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface StockFactors {
  symbol: string
  market_cap: number | null
  daily_turnover: number | null
  foreign_net_5d: number | null
  trust_net_5d: number | null
  rsi14: number | null
  macd_hist: number | null
  volume_ratio: number | null
  // Liquidity factors (computed by computeLiquidityFactors)
  adtv20_log?: number | null         // log(20d avg daily turnover TWD)
  amihud20_inv?: number | null       // inverted Amihud (higher = more liquid)
  turnover_rate20?: number | null    // volume / shares outstanding
  volume_cv20_inv?: number | null    // 1/(1+CV), higher = more consistent
  spread_proxy20_inv?: number | null // 1/spread, higher = tighter spread
}

export interface PercentileScore {
  chip_score: number       // 0-40
  tech_score: number       // 0-30
  liquidity_score: number  // 0-30
  total_score: number      // 0-100
}

export interface LiquidityFactors {
  adtv20: number | null
  adtv20_log: number | null
  amihud20: number | null
  amihud20_inv: number | null
  turnover_rate20: number | null
  volume_cv20: number | null
  volume_cv20_inv: number | null
  spread_proxy20: number | null
  spread_proxy20_inv: number | null
}

// ── Liquidity Factor Computation ─────────────────────────────────────────────

interface PriceBar {
  close: number
  high: number
  low: number
  volume: number
  trading_money?: number  // TWSE 官方成交金額（若有）
}

/**
 * Compute 5 liquidity factors from 20-day OHLCV data.
 * All factors computed from daily data only — no order book needed.
 */
export function computeLiquidityFactors(
  bars: PriceBar[],
  sharesOutstanding?: number,
): LiquidityFactors {
  const nullResult: LiquidityFactors = {
    adtv20: null, adtv20_log: null,
    amihud20: null, amihud20_inv: null,
    turnover_rate20: null,
    volume_cv20: null, volume_cv20_inv: null,
    spread_proxy20: null, spread_proxy20_inv: null,
  }

  const recent = bars.slice(-20).filter(b =>
    b.close > 0 && b.high > 0 && b.low > 0 && b.high >= b.low
  )
  if (recent.length < 10) return nullResult

  // 1. ADTV: use official trading_money if available, else close*volume
  const turnoverValues = recent.map(b =>
    (b.trading_money && b.trading_money > 0) ? b.trading_money : b.close * b.volume
  )
  const adtv20 = turnoverValues.reduce((s, v) => s + v, 0) / turnoverValues.length
  const adtv20_log = adtv20 > 0 ? Math.log10(adtv20) : null

  // 2. Amihud: |daily return| / daily turnover value
  //    Exclude limit-up/down days (|ret| >= 9.5%) to avoid artificial spikes
  let amihudSum = 0
  let amihudCount = 0
  for (let i = 1; i < recent.length; i++) {
    const ret = Math.abs(recent[i].close / recent[i - 1].close - 1)
    const tv = turnoverValues[i]
    if (ret < 0.095 && tv > 0) {
      amihudSum += ret / tv
      amihudCount++
    }
  }
  const amihud20 = amihudCount >= 5 ? (amihudSum / amihudCount) * 1e8 : null
  const amihud20_inv = amihud20 != null && amihud20 > 0 ? 1 / amihud20 : null

  // 3. Turnover rate: volume / shares outstanding (requires float data)
  let turnover_rate20: number | null = null
  if (sharesOutstanding && sharesOutstanding > 0) {
    const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length
    turnover_rate20 = avgVol / sharesOutstanding
  }

  // 4. Volume consistency: CV = std/mean of daily turnover (lower = more consistent)
  const tvMean = adtv20
  const tvStd = Math.sqrt(
    turnoverValues.reduce((s, v) => s + (v - tvMean) ** 2, 0) / turnoverValues.length
  )
  const volume_cv20 = tvMean > 0 ? tvStd / tvMean : null
  const volume_cv20_inv = volume_cv20 != null ? 1 / (1 + volume_cv20) : null

  // 5. Spread proxy: mean((high-low)/close), lower = tighter spread
  const validBars = recent.filter(b => b.high > b.low)
  const spread_proxy20 = validBars.length >= 5
    ? validBars.reduce((s, b) => s + (b.high - b.low) / b.close, 0) / validBars.length
    : null
  const spread_proxy20_inv = spread_proxy20 != null && spread_proxy20 > 0
    ? 1 / spread_proxy20
    : null

  return {
    adtv20, adtv20_log,
    amihud20, amihud20_inv,
    turnover_rate20,
    volume_cv20, volume_cv20_inv,
    spread_proxy20, spread_proxy20_inv,
  }
}

// ── Percentile Scorer ────────────────────────────────────────────────────────

export class PercentileScorer {
  private percentiles: Map<string, number[]> = new Map()

  // Score allocation: Chip 40 + Tech 30 + Liquidity 30 = 100
  private factorMaxScores: Record<string, number> = {
    // Chip (40 total)
    foreign_net_5d: 20,
    trust_net_5d: 15,
    volume_ratio: 5,
    // Tech (30 total)
    rsi14: 10,
    macd_hist: 10,
    market_cap: 10,
    // Liquidity (30 total) — 5-factor composite
    adtv20_log: 10,          // absolute tradability (log-scaled)
    amihud20_inv: 9,         // price impact (inverted: higher = more liquid)
    turnover_rate20: 6,      // relative activity vs float
    volume_cv20_inv: 3,      // consistency (inverted CV)
    spread_proxy20_inv: 2,   // bid-ask spread proxy (inverted)
  }

  constructor(universe: StockFactors[]) {
    this.buildPercentiles(universe)
  }

  private buildPercentiles(universe: StockFactors[]) {
    const factors = [
      // Chip
      'foreign_net_5d', 'trust_net_5d', 'volume_ratio',
      // Tech
      'rsi14', 'macd_hist', 'market_cap',
      // Liquidity (all "higher = better" after inversion)
      'adtv20_log', 'amihud20_inv', 'turnover_rate20',
      'volume_cv20_inv', 'spread_proxy20_inv',
    ] as const

    for (const factor of factors) {
      const values = universe
        .map(s => (s as any)[factor])
        .filter((v): v is number => v != null && !isNaN(v) && isFinite(v))
        .sort((a, b) => a - b)
      this.percentiles.set(factor, values)
    }
  }

  private getPercentile(factor: string, value: number | null | undefined): number {
    if (value == null || isNaN(value) || !isFinite(value)) return 0.5  // neutral
    const sorted = this.percentiles.get(factor)
    if (!sorted || sorted.length === 0) return 0.5

    // Binary search for percentile
    let lo = 0, hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < value) lo = mid + 1
      else hi = mid
    }
    return lo / sorted.length
  }

  score(stock: StockFactors): PercentileScore {
    // ── Chip score (0-40) ──
    const chip_score = Math.round(
      this.getPercentile('foreign_net_5d', stock.foreign_net_5d) * this.factorMaxScores.foreign_net_5d +
      this.getPercentile('trust_net_5d', stock.trust_net_5d) * this.factorMaxScores.trust_net_5d +
      this.getPercentile('volume_ratio', stock.volume_ratio) * this.factorMaxScores.volume_ratio
    )

    // ── Tech score (0-30) ──
    const tech_score = Math.round(
      this.getPercentile('rsi14', stock.rsi14) * this.factorMaxScores.rsi14 +
      this.getPercentile('macd_hist', stock.macd_hist) * this.factorMaxScores.macd_hist +
      this.getPercentile('market_cap', stock.market_cap) * this.factorMaxScores.market_cap
    )

    // ── Liquidity score (0-30): 5-factor composite ──
    const liquidity_score = Math.round(
      this.getPercentile('adtv20_log', stock.adtv20_log) * this.factorMaxScores.adtv20_log +
      this.getPercentile('amihud20_inv', stock.amihud20_inv) * this.factorMaxScores.amihud20_inv +
      this.getPercentile('turnover_rate20', stock.turnover_rate20) * this.factorMaxScores.turnover_rate20 +
      this.getPercentile('volume_cv20_inv', stock.volume_cv20_inv) * this.factorMaxScores.volume_cv20_inv +
      this.getPercentile('spread_proxy20_inv', stock.spread_proxy20_inv) * this.factorMaxScores.spread_proxy20_inv
    )

    return {
      chip_score,
      tech_score,
      liquidity_score,
      total_score: chip_score + tech_score + liquidity_score,
    }
  }
}
