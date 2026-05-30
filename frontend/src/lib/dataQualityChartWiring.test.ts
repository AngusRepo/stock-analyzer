import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartPath = path.join(root, 'src', 'components', 'charts', 'DataQualityTrendChart.tsx')
const pagePath = path.join(root, 'src', 'pages', 'DataQualityPage.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'DataQualityTrendChart component should exist')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes("from 'lightweight-charts'"), 'DataQualityTrendChart should use lightweight-charts')
assert(chart.includes('LineSeries'), 'DataQualityTrendChart should render a quality-score line')
assert(chart.includes('HistogramSeries'), 'DataQualityTrendChart should render severity histograms')
assert(chart.includes('createSeriesMarkers'), 'DataQualityTrendChart should render warn/fail markers')
assert(chart.includes('Data Quality Visual Workbench'), 'DataQualityTrendChart should render a visible visual workbench')
assert(chart.includes('這不是歷史趨勢'), 'DataQualityTrendChart should disclose that current API data is a snapshot, not historical trend')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('DataQualityTrendChart'), 'DataQualityPage should render DataQualityTrendChart')
assert(page.includes('report={report}'), 'DataQualityPage should pass the data-quality report into the chart')
assert(page.includes('loading={quality.isLoading}'), 'DataQualityPage should pass loading state into the chart')
assert(page.includes('error={quality.error}'), 'DataQualityPage should pass error state into the chart')
assert(page.includes('FinLab Dagster Data Quality'), 'DataQualityPage should expose FinLab Dagster source coverage')
assert(page.includes('dataQualityApi.v41RuntimeStatus'), 'DataQualityPage should fetch V4.1 data runtime status')
assert(page.includes('source_quality_metrics'), 'DataQualityPage should show source quality metrics')
assert(page.includes('canonical_rows'), 'DataQualityPage should show canonical row coverage')
assert(page.includes('institutional_amount_daily'), 'DataQualityPage should show FinLab institutional amount canonical row coverage')
assert(page.includes('broker_flow_daily'), 'DataQualityPage should show FinLab broker-flow canonical row coverage')
assert(!page.includes('鞈??釭'), 'DataQualityPage visible title should not contain mojibake')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Data Quality chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Data Quality chart should use the accepted Apache-2.0 chart dependency')
