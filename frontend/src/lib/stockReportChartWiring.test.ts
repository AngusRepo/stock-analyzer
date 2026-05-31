import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'StockReportPage.tsx')
const chartPath = path.join(root, 'src', 'components', 'charts', 'DashboardV4LightweightChart.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'Stock report should reuse the DashboardV4LightweightChart component')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('DashboardV4LightweightChart'), 'StockReportPage should render DashboardV4LightweightChart')
assert(page.includes('dashboardV4Api'), 'StockReportPage should fetch the Dashboard V4 chart packet')
assert(page.includes("queryKey: ['dashboard-v4-chart', 'report', stockId]"), 'StockReportPage should keep report chart cache scoped by stockId')
assert(page.includes('packet={chartPacket}'), 'StockReportPage should pass chart packet into DashboardV4LightweightChart')
assert(page.includes('loading={chartLoading}'), 'StockReportPage should pass chart loading state')
assert(page.includes('error={chartError}'), 'StockReportPage should pass chart error state')
assert(page.includes('AppShell'), 'StockReportPage should use the shared workstation shell')
assert(page.includes('data-testid="stock-report-signal-board"'), 'StockReportPage should expose a visual signal board before dense analysis sections')
assert(page.includes('WorkstationPageTitle') && page.includes('sv-content-card') && page.includes('sv-accent-text'), 'StockReportPage should consume route-level stock surface tokens')
assert(page.indexOf('DashboardV4LightweightChart') < page.indexOf('投資信號總覽'), 'Stock report chart should render before prose-led signal sections')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes('sv-content-card') && chart.includes('sv-accent-text') && chart.includes('sv-muted-text'), 'DashboardV4LightweightChart should consume active route surface tokens')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Stock report chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Stock report chart should use the accepted Apache-2.0 chart dependency')
