import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartPath = path.join(root, 'src', 'components', 'charts', 'PaperTradePerformanceChart.tsx')
const pagePath = path.join(root, 'src', 'pages', 'BotDashboard.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'PaperTradePerformanceChart component should exist')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes("from 'lightweight-charts'"), 'PaperTradePerformanceChart should use lightweight-charts')
assert(chart.includes('AreaSeries'), 'PaperTradePerformanceChart should render the bot equity curve as an area series')
assert(chart.includes('LineSeries'), 'PaperTradePerformanceChart should render benchmark / TWII overlays')
assert(chart.includes('HistogramSeries'), 'PaperTradePerformanceChart should render drawdown or daily-risk histograms')
assert(chart.includes('createSeriesMarkers'), 'PaperTradePerformanceChart should render execution markers')
assert(chart.includes('Paper Trading Visual Workbench'), 'PaperTradePerformanceChart should render a visible visual workbench')
assert(chart.includes('buildPaperTradePerformancePoints('), 'PaperTradePerformanceChart should build points from paper PnL snapshots')
assert(chart.includes('buildExecutionMarkers('), 'PaperTradePerformanceChart should build markers from orders and pending buys')
assert(chart.includes('00981A') && chart.includes('00631L') && chart.includes('00403A'), 'PaperTradePerformanceChart should render the approved ETF comparison set')
assert(chart.includes('firstPositiveValue('), 'PaperTradePerformanceChart should normalize each benchmark from its first valid value, not the first snapshot row')
assert(!chart.includes('orderText('), 'PaperTradePerformanceChart markers should not print stock-code buy/sell labels on the curve')
assert(chart.includes('paperOrdersFromPayload(orders)'), 'PaperTradePerformanceChart should defensively normalize order props')
assert(chart.includes('paperPendingBuysFromPayload(pendingBuys)'), 'PaperTradePerformanceChart should defensively normalize pending-buy props')
assert(chart.includes('paperPnlSnapshotsFromPayload(pnl)'), 'PaperTradePerformanceChart should defensively normalize PnL snapshots')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('PaperTradePerformanceChart'), 'BotDashboard should render PaperTradePerformanceChart')
assert(page.includes("queryKey: ['paper', 'orders', 'performance-chart']"), 'BotDashboard performance chart should fetch execution orders for markers')
assert(page.includes("queryKey: ['paper', 'pending-buys', 'performance-chart']"), 'BotDashboard performance chart should fetch pending buys for markers')
assert(page.includes('pnl={data}'), 'BotDashboard should pass paper PnL data into the performance chart')
assert(page.includes('paperOrdersFromPayload(ordersData)'), 'BotDashboard should normalize Worker order payloads before charting')
assert(page.includes('orders={orders}'), 'BotDashboard should pass normalized orders into the performance chart')
assert(page.includes('pendingBuys={pendingBuys}'), 'BotDashboard should pass pending buys into the performance chart')
assert(page.includes('PBO alpha credibility'), 'Weekly validation should split PBO alpha credibility into its own card')
assert(page.includes('MC tail risk'), 'Weekly validation should split MC tail risk into its own card')
assert(page.includes('Backtest consistency'), 'Weekly validation should split backtest consistency into its own card')
assert(page.includes('LOW_SAMPLE_TAIL_RISK'), 'Weekly validation should surface low-sample MC tail-risk status')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Bot Dashboard chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Bot Dashboard chart should use the accepted Apache-2.0 chart dependency')
