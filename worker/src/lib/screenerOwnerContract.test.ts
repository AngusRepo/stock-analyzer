const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pendingBuyOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const screenerMarketData = fs.readFileSync('src/lib/screenerMarketData.ts', 'utf8')
const stocksRoute = fs.readFileSync('src/routes/stocks.ts', 'utf8')

{
  assert(fs.existsSync('src/lib/screenerMarketData.ts'), 'screener market data loader should live in its own domain module')
  assert(marketScreener.includes("from './screenerMarketData'"), 'marketScreener should import the market data loader module')
  assert(!marketScreener.includes('async function loadMarketDataFromD1'), 'marketScreener should not own D1 market data loading')
}

{
  assert(!marketScreener.includes("../routes/stocks"), 'screener lib must not import route modules')
  assert(!marketScreener.includes("from './stocks'"), 'screener lib must not import stocks route')
  assert(marketScreener.includes("from './technicalIndicators'"), 'screener should use technical indicator domain service')
  assert(screenerMarketData.includes('isAutoTradablePriceRow'), 'screener market data must own auto-tradable universe filtering')
  assert(pendingBuyOrchestrator.includes("COALESCE(s.market, '') != 'EMERGING'"), 'pending-buy setup must exclude explicit emerging-board stocks')
  assert(pendingBuyOrchestrator.includes('sp_exec.open'), 'pending-buy setup must reject emerging-style rows without an executable open price')
}

{
  assert(!stocksRoute.includes('function computeTechnicalIndicators'), 'stocks route must not own indicator formula implementation')
  assert(stocksRoute.includes("../lib/technicalIndicators"), 'stocks route should call technical indicator domain service')
}
