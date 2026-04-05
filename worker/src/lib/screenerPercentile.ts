/**
 * screenerPercentile.ts — P2#25 Screener Continuous Percentile Scoring
 *
 * Replace hardcoded grading rules (>10B=36, >5B=28...) with percentile ranking.
 * Each factor's percentile in universe × max score = smooth, fair scoring.
 *
 * Usage:
 *   const scorer = new PercentileScorer(allStocks)
 *   const score = scorer.score(stock)
 */

export interface StockFactors {
  symbol: string
  market_cap: number | null
  daily_turnover: number | null
  foreign_net_5d: number | null
  trust_net_5d: number | null
  rsi14: number | null
  macd_hist: number | null
  volume_ratio: number | null
}

export interface PercentileScore {
  chip_score: number    // 0-40
  tech_score: number    // 0-30
  liquidity_score: number  // 0-30
  total_score: number   // 0-100
}

export class PercentileScorer {
  private percentiles: Map<string, number[]> = new Map()
  private factorMaxScores: Record<string, number> = {
    // Chip (40 total)
    foreign_net_5d: 20,
    trust_net_5d: 15,
    volume_ratio: 5,
    // Tech (30 total)
    rsi14: 10,
    macd_hist: 10,
    market_cap: 10,
    // Liquidity (30 total)
    daily_turnover: 30,
  }

  constructor(universe: StockFactors[]) {
    this.buildPercentiles(universe)
  }

  private buildPercentiles(universe: StockFactors[]) {
    const factors = ['foreign_net_5d', 'trust_net_5d', 'volume_ratio',
                     'rsi14', 'macd_hist', 'market_cap', 'daily_turnover'] as const

    for (const factor of factors) {
      const values = universe
        .map(s => (s as any)[factor])
        .filter((v): v is number => v != null && !isNaN(v))
        .sort((a, b) => a - b)
      this.percentiles.set(factor, values)
    }
  }

  private getPercentile(factor: string, value: number | null): number {
    if (value == null || isNaN(value)) return 0.5  // neutral
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
    // Chip score (0-40): foreign + trust + volume ratio
    const foreignPct = this.getPercentile('foreign_net_5d', stock.foreign_net_5d)
    const trustPct = this.getPercentile('trust_net_5d', stock.trust_net_5d)
    const volRatioPct = this.getPercentile('volume_ratio', stock.volume_ratio)

    const chip_score = Math.round(
      foreignPct * this.factorMaxScores.foreign_net_5d +
      trustPct * this.factorMaxScores.trust_net_5d +
      volRatioPct * this.factorMaxScores.volume_ratio
    )

    // Tech score (0-30): RSI + MACD + market cap
    const rsiPct = this.getPercentile('rsi14', stock.rsi14)
    const macdPct = this.getPercentile('macd_hist', stock.macd_hist)
    const mcapPct = this.getPercentile('market_cap', stock.market_cap)

    const tech_score = Math.round(
      rsiPct * this.factorMaxScores.rsi14 +
      macdPct * this.factorMaxScores.macd_hist +
      mcapPct * this.factorMaxScores.market_cap
    )

    // Liquidity score (0-30): daily turnover + combined
    const turnoverPct = this.getPercentile('daily_turnover', stock.daily_turnover)
    const liquidity_score = Math.round(
      turnoverPct * this.factorMaxScores.daily_turnover
    )

    return {
      chip_score,
      tech_score,
      liquidity_score,
      total_score: chip_score + tech_score + liquidity_score,
    }
  }
}
