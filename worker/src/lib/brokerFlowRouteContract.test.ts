import fs from 'node:fs'
import assert from 'node:assert/strict'

const stocksRoute = fs.readFileSync('src/routes/stocks.ts', 'utf8')
const frontendApi = fs.readFileSync('../frontend/src/lib/api.ts', 'utf8')
const candlestickChart = fs.readFileSync('../frontend/src/components/CandlestickChart.tsx', 'utf8')

assert(
  stocksRoute.includes("stocks.get('/:id/broker-flow'"),
  'stocks route must expose read-only per-stock broker-flow endpoint',
)
assert(
  stocksRoute.includes('canonical_broker_flow_daily'),
  'broker-flow endpoint must read canonical_broker_flow_daily',
)
assert(
  stocksRoute.includes('WHERE stock_id=? AND date>=?') && stocksRoute.includes('bind(stock.symbol, since)'),
  'broker-flow endpoint must query by canonical symbol stock_id and bounded date window',
)
assert(
  stocksRoute.includes('optional canonical_broker_flow_daily unavailable') && stocksRoute.includes('return c.json([])'),
  'broker-flow endpoint must fail soft when optional canonical table is unavailable',
)

assert(
  frontendApi.includes('brokerFlow:') && frontendApi.includes('/broker-flow?days='),
  'frontend API client must expose stocksApi.brokerFlow',
)
assert(
  candlestickChart.includes('buildBrokerFlowLine') && candlestickChart.includes('brokerSummary'),
  'CandlestickChart must consume broker flow series and summary',
)
