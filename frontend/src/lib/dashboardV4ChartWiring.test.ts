import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartComponentPath = path.join(root, 'src', 'components', 'charts', 'DashboardV4LightweightChart.tsx')
const stockReportPagePath = path.join(root, 'src', 'pages', 'StockReportPage.tsx')
const marketHomePagePath = path.join(root, 'src', 'pages', 'MarketHomePage.tsx')
const viteConfigPath = path.join(root, 'vite.config.ts')

assert(fs.existsSync(chartComponentPath), 'DashboardV4LightweightChart component should exist')

const component = fs.readFileSync(chartComponentPath, 'utf8')
assert(component.includes("from 'lightweight-charts'"), 'DashboardV4LightweightChart should import lightweight-charts')
assert(component.includes('createChart'), 'DashboardV4LightweightChart should create a Lightweight chart')
assert(component.includes('createSeriesMarkers'), 'DashboardV4LightweightChart should render model signal markers')
assert(component.includes('CandlestickSeries'), 'DashboardV4LightweightChart should render OHLC candles')
assert(component.includes('HistogramSeries'), 'DashboardV4LightweightChart should render volume or flow histograms')
assert(component.includes('buildDashboardV4ChartViewModel'), 'DashboardV4LightweightChart should consume the shared view model')

const stockReportPage = fs.readFileSync(stockReportPagePath, 'utf8')
assert(stockReportPage.includes('DashboardV4LightweightChart'), 'StockReportPage should render DashboardV4LightweightChart')
assert(stockReportPage.includes('dashboardV4Api.stockChart'), 'StockReportPage should fetch the Dashboard V4 chart packet')
assert(stockReportPage.includes("queryKey: ['dashboard-v4-chart', 'report', stockId]"), 'Stock report chart cache should stay scoped by stockId')

const marketHomePage = fs.readFileSync(marketHomePagePath, 'utf8')
assert(marketHomePage.includes('const RecommendationCardClean = lazy(loadRecommendationCardClean)'), 'Home recommendation cards must remain lazy so Lightweight Charts stays outside initial navigation')
assert(marketHomePage.includes('<Suspense fallback='), 'Home recommendation cards must expose a stable loading fallback')

const viteConfig = fs.readFileSync(viteConfigPath, 'utf8')
assert(!viteConfig.includes("'vendor-charts': ['recharts', 'lightweight-charts']"), 'Vite must not force both chart libraries into one shared chunk')
