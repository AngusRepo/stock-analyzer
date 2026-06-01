import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const appPath = path.join(root, 'src', 'App.tsx')
const appShellPath = path.join(root, 'src', 'components', 'AppShell.tsx')
const dashboardPath = path.join(root, 'src', 'pages', 'Dashboard.tsx')
const stockAIReportPath = path.join(root, 'src', 'components', 'StockAIReport.tsx')
const legacyReportRedirectPath = path.join(root, 'src', 'pages', 'LegacyStockReportRedirectPage.tsx')
const chartPath = path.join(root, 'src', 'components', 'charts', 'DashboardV4LightweightChart.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'Stock report should reuse the DashboardV4LightweightChart component')
assert(fs.existsSync(legacyReportRedirectPath), 'Legacy /report/:symbol should be an explicit redirect page')

const app = fs.readFileSync(appPath, 'utf8')
const appShell = fs.readFileSync(appShellPath, 'utf8')
const dashboard = fs.readFileSync(dashboardPath, 'utf8')
const stockAIReport = fs.readFileSync(stockAIReportPath, 'utf8')
const legacyRedirect = fs.readFileSync(legacyReportRedirectPath, 'utf8')

assert(app.includes("const LegacyStockReportRedirectPage = lazy(() => import('./pages/LegacyStockReportRedirectPage'))"), 'App should lazy-load the legacy report redirect page')
assert(app.includes('path="/report/:symbol"') && app.includes('<LegacyStockReportRedirectPage />'), 'Legacy /report/:symbol route should no longer render the retired standalone StockReportPage')
assert(!app.includes("import('./pages/StockReportPage')"), 'App should not lazy-load the retired standalone StockReportPage as a formal route')
assert(legacyRedirect.includes("LEGACY_STOCK_REPORT_REDIRECT_TARGET = '/'"), 'Legacy report redirect should return old report URLs to formal Home')
assert(legacyRedirect.includes('<Redirect to={LEGACY_STOCK_REPORT_REDIRECT_TARGET} replace />'), 'Legacy report redirect should be immediate and replace browser history')
assert(!legacyRedirect.includes('stocksApi.search') && !legacyRedirect.includes('useQuery'), 'Legacy report redirect should not call stock search or show an old stock-report loading shell')

assert(appShell.includes("currentPath.startsWith('/stock/')"), 'Current /stock/:id workspace should receive the stock detail surface theme')
assert(!appShell.includes("currentPath.startsWith('/report/')"), 'Legacy /report/:symbol must not remain the formal stock surface owner')

assert(app.includes('<Route path="/stock/:id" component={Dashboard} />'), 'Stock route alias should still land in Dashboard while the standalone report page is retired')
assert(dashboard.includes('DashboardV4LightweightChart'), 'Dashboard stock selection workspace should render DashboardV4LightweightChart')
assert(dashboard.includes('dashboardV4Api.stockChart'), 'Dashboard stock selection workspace should fetch the Dashboard V4 chart packet')
assert(dashboard.includes('StockAIReport'), 'Dashboard stock selection workspace should embed the current StockAIReport AI tab')
assert(stockAIReport.includes('StockAIReport') && stockAIReport.includes('buildScoreBreakdownViewModel'), 'Current AI stock report should live in StockAIReport, not the legacy standalone page')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes('sv-content-card') && chart.includes('sv-accent-text') && chart.includes('sv-muted-text'), 'DashboardV4LightweightChart should consume active route surface tokens')
assert(chart.includes('data-testid="dashboard-v4-chart-empty-state"'), 'DashboardV4LightweightChart should expose a compact empty/error chart state')
assert(chart.includes('Dashboard V4 chart status') && chart.includes("status?: 'waiting' | 'filtered' | 'error'"), 'DashboardV4LightweightChart empty state should show a typed packet/candle/error status')
assert(!chart.includes('min-h-[460px] place-items-center rounded-xl px-4 text-center'), 'DashboardV4LightweightChart empty state should not reserve full chart height when no packet exists')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Stock report chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Stock report chart should use the accepted Apache-2.0 chart dependency')
