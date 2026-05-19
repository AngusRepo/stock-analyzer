import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartComponentPath = path.join(root, 'src', 'components', 'charts', 'DashboardV4LightweightChart.tsx')
const dashboardPath = path.join(root, 'src', 'pages', 'Dashboard.tsx')
const viteConfigPath = path.join(root, 'vite.config.ts')

assert(fs.existsSync(chartComponentPath), 'DashboardV4LightweightChart component should exist')

const component = fs.readFileSync(chartComponentPath, 'utf8')
assert(component.includes("from 'lightweight-charts'"), 'DashboardV4LightweightChart should import lightweight-charts')
assert(component.includes('createChart'), 'DashboardV4LightweightChart should create a Lightweight chart')
assert(component.includes('createSeriesMarkers'), 'DashboardV4LightweightChart should render model signal markers')
assert(component.includes('CandlestickSeries'), 'DashboardV4LightweightChart should render OHLC candles')
assert(component.includes('HistogramSeries'), 'DashboardV4LightweightChart should render volume or flow histograms')
assert(component.includes('buildDashboardV4ChartViewModel'), 'DashboardV4LightweightChart should consume the shared view model')

const dashboard = fs.readFileSync(dashboardPath, 'utf8')
assert(dashboard.includes('DashboardV4LightweightChart'), 'Dashboard should render DashboardV4LightweightChart')
assert(dashboard.includes('dashboardV4Api.stockChart'), 'Dashboard should fetch the Dashboard V4 chart packet')

const viteConfig = fs.readFileSync(viteConfigPath, 'utf8')
assert(viteConfig.includes("'vendor-charts': ['recharts', 'lightweight-charts']"), 'Vite chart vendor chunk should include lightweight-charts')
