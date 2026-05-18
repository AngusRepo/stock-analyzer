import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartPath = path.join(root, 'src', 'components', 'charts', 'ObservabilityEventTimeline.tsx')
const pagePath = path.join(root, 'src', 'pages', 'ObservabilityPage.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'ObservabilityEventTimeline component should exist')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes("from 'lightweight-charts'"), 'ObservabilityEventTimeline should use lightweight-charts')
assert(chart.includes('LineSeries'), 'ObservabilityEventTimeline should render a severity line')
assert(chart.includes('HistogramSeries'), 'ObservabilityEventTimeline should render event-count histograms')
assert(chart.includes('createSeriesMarkers'), 'ObservabilityEventTimeline should render warn/error markers')
assert(chart.includes('Observability Visual Workbench'), 'ObservabilityEventTimeline should render a visible visual workbench')
assert(chart.includes('eventTime(event.ts'), 'ObservabilityEventTimeline should use event timestamps instead of synthetic row labels')
assert(chart.includes('repeat(24,minmax(18px,1fr))'), 'Severity buckets should fill the 24-hour workbench width instead of bunching at the left edge')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('ObservabilityEventTimeline'), 'ObservabilityPage should render ObservabilityEventTimeline')
assert(page.includes('report={observability.data}'), 'ObservabilityPage should pass the event report into the chart')
assert(page.includes('loading={observability.isLoading}'), 'ObservabilityPage should pass loading state into the chart')
assert(page.includes('error={observability.error}'), 'ObservabilityPage should pass error state into the chart')
assert(page.indexOf('ObservabilityEventTimeline') < page.indexOf('AdaptiveMetaPanel'), 'Observability visual workbench should render before secondary panels')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'OBS chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'OBS chart should use the accepted Apache-2.0 chart dependency')
