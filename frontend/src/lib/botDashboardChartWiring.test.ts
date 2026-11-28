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
const series = fs.readFileSync(path.join(root, 'src', 'lib', 'paperPerformanceSeries.ts'), 'utf8')
assert(chart.includes("from 'lightweight-charts'"), 'PaperTradePerformanceChart should use lightweight-charts')
// 11/26 Wei 定案：只和大盤（TWII）與 0050 比，bot↔0050 之間塗差距帶；其他 ETF 與回撤直方圖拿掉。
assert(chart.includes('AreaSeries') && chart.includes("gapBandData(points, '0050'"), 'PaperTradePerformanceChart should shade the bot↔0050 gap band')
assert(chart.includes('LineSeries'), 'PaperTradePerformanceChart should render benchmark / TWII overlays')
assert(chart.includes('createSeriesMarkers'), 'PaperTradePerformanceChart should render execution markers')
assert(chart.includes('Paper Trading Visual Workbench'), 'PaperTradePerformanceChart should render a visible visual workbench')
assert(chart.includes('buildPaperTradePerformancePoints('), 'PaperTradePerformanceChart should build points from paper PnL snapshots')
assert(chart.includes('buildExecutionMarkers('), 'PaperTradePerformanceChart should build markers from orders and pending buys')
assert(chart.includes("key: '0050'") && chart.includes("key: 'TWII'") && !chart.includes("key: '00981A'") && !chart.includes("key: '00631L'") && !chart.includes("key: '00403A'"), 'PaperTradePerformanceChart compares only against TWII and 0050')
assert(series.includes('export function benchmarkBases('), 'Benchmarks share the bot start as base; late series start from their own first value')
assert(chart.includes('起算'), 'A benchmark that starts after the bot must be labelled with its own start date')
assert(series.includes("if (value == null || value === '') return null"), 'Missing snapshot values must not coerce to 0 (Number(null) === 0 plotted TWII at -100%)')
assert(series.includes('return value != null && value > 0 ? value : null'), 'Non-positive benchmark prices must be gaps, not -100% returns')
assert(!chart.includes('orderText('), 'PaperTradePerformanceChart markers should not print stock-code buy/sell labels on the curve')
assert(chart.includes('paperOrdersFromPayload(orders)'), 'PaperTradePerformanceChart should defensively normalize order props')
assert(chart.includes('paperPendingBuysFromPayload(pendingBuys)'), 'PaperTradePerformanceChart should defensively normalize pending-buy props')
assert(series.includes('paperPnlSnapshotsFromPayload<any>(pnl)'), 'PaperTradePerformanceChart should defensively normalize PnL snapshots')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('PaperTradePerformanceChart'), 'BotDashboard should render PaperTradePerformanceChart')
// The chart shares the order-list and SignalTable query keys; a chart-only key fetched the same payload twice per visit.
assert(!page.includes("'performance-chart']"), 'BotDashboard performance chart must reuse the shared paper query keys instead of refetching')
assert((page.match(/queryKey: \['paper', 'orders'\],/g) ?? []).length === 2, 'BotDashboard performance chart should share the order-list query for markers')
// SignalTable、績效圖標記、強弱軌跡空狀態判斷共用同一個 pending-buys key。
assert((page.match(/queryKey: \['paper', 'pending-buys'\],/g) ?? []).length >= 2, 'BotDashboard performance chart should share the SignalTable pending-buys query for markers')
assert(page.includes('pnl={data}'), 'BotDashboard should pass paper PnL data into the performance chart')
assert(page.includes('paperOrdersFromPayload(ordersData)'), 'BotDashboard should normalize Worker order payloads before charting')
assert(page.includes('orders={orders}'), 'BotDashboard should pass normalized orders into the performance chart')
assert(page.includes('pendingBuys={pendingBuys}'), 'BotDashboard should pass pending buys into the performance chart')
// 2026-11-26 batch3: the three weekly-validation cells now have Chinese labels (English codes stay in tooltips).
assert(page.includes('PBO 可信度'), 'Weekly validation should split PBO alpha credibility into its own cell')
assert(page.includes('尾端風險（MC）'), 'Weekly validation should split MC tail risk into its own cell')
assert(page.includes('回測一致性'), 'Weekly validation should split backtest consistency into its own cell')
assert(page.includes('LOW_SAMPLE_TAIL_RISK'), 'Weekly validation should surface low-sample MC tail-risk status')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Bot Dashboard chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Bot Dashboard chart should use the accepted Apache-2.0 chart dependency')
