import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(startIndex >= 0, `missing section start: ${start}`)
  assert(endIndex > startIndex, `missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

const route = readFileSync('src/routes/other.ts', 'utf8')
const fearGreed = section(route, 'function buildFearGreedIndex', 'function buildHedgeSentimentFactors')
const hedgeFactors = section(route, 'function buildHedgeSentimentFactors', 'function hedgeSentimentLabel')
const hedgeScore = section(route, 'function buildHedgeSentiment', 'function cycleSignalLabel')
const hedgeSentiment = `${hedgeFactors}\n${hedgeScore}`

for (const required of [
  'market_momentum',
  'options_positioning',
  'volatility_pressure',
  'credit_stress',
  'safe_haven_fx',
  'global_risk_appetite',
]) {
  assert(fearGreed.includes(required), `Fear & Greed must keep core risk-appetite factor: ${required}`)
}

for (const forbidden of [
  'business_cycle_heat',
  'businessCycle',
  'foreignNet5d',
  'largeTraderNet',
  'positioning_flow',
]) {
  assert(!fearGreed.includes(forbidden), `Fear & Greed must not include non-core or hedge-only factor: ${forbidden}`)
}

for (const required of [
  'foreign_net_5d',
  'large_trader_net',
  'put_call_ratio',
  'twii_vol20',
  'us_vix',
  'hy_spread',
  'dxy_return',
  'usd_twd',
]) {
  assert(hedgeSentiment.includes(required), `Hedge sentiment must keep hedge/protection factor: ${required}`)
}

for (const forbidden of ['businessCycle', 'business_cycle_heat', 'global_event']) {
  assert(!hedgeSentiment.includes(forbidden), `Hedge sentiment must not include macro-cycle or subjective news factor: ${forbidden}`)
}
