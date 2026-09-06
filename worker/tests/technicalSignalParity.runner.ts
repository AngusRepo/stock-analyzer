// Local test-only runner. Executes actual production scoring, no network or D1.
import { readFileSync } from 'node:fs'
import { scoreMultiFactor } from '../src/lib/marketScreener'
import { computeTechnicalIndicators } from '../src/lib/technicalIndicators'
import { macdHistogramLast } from '../src/lib/technicalSignalMath'

const fixtures = JSON.parse(readFileSync(0, 'utf8')) as Array<{ prices: any[]; config?: any }>
const output = fixtures.map(({ prices, config }) => {
  const closes = prices.map(p => p.close)
  const score = scoreMultiFactor(prices, undefined, 0, closes[closes.length - 1], config)
  return { scores: [score.base_score, score.chip_score, score.tech_score, score.momentum_score],
    macd: macdHistogramLast(closes),
    indicator: computeTechnicalIndicators(closes, prices.map(p => p.max), prices.map(p => p.min), prices.map(p => p.Trading_Volume)).macdHist }
})
process.stdout.write(JSON.stringify(output))
