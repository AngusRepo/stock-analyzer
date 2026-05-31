import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartPath = path.join(root, 'src', 'components', 'charts', 'SchedulerCadenceChart.tsx')
const pagePath = path.join(root, 'src', 'pages', 'SchedulerPage.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'SchedulerCadenceChart component should exist')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes("from 'lightweight-charts'"), 'SchedulerCadenceChart should use lightweight-charts')
assert(chart.includes('LineSeries'), 'SchedulerCadenceChart should render a 7d SLO/cadence line')
assert(chart.includes('HistogramSeries'), 'SchedulerCadenceChart should render failed/suspicious run bars')
assert(chart.includes('createSeriesMarkers'), 'SchedulerCadenceChart should render failed/suspicious markers')
assert(chart.includes('Scheduler Visual Workbench'), 'SchedulerCadenceChart should render a visible visual workbench')
assert(chart.includes('durationRiskScore('), 'SchedulerCadenceChart should score suspicious duration instead of showing raw strings only')
assert(chart.includes('history7d'), 'SchedulerCadenceChart should consume scheduler history7d evidence')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('SchedulerCadenceChart'), 'SchedulerPage should render SchedulerCadenceChart')
assert(page.includes('status={scheduler.data}'), 'SchedulerPage should pass scheduler status into the chart')
assert(page.includes('loading={scheduler.isLoading}'), 'SchedulerPage should pass loading state into the chart')
assert(page.includes('error={scheduler.error}'), 'SchedulerPage should pass error state into the chart')
assert(page.includes('data-testid="scheduler-signal-board"'), 'SchedulerPage should expose a visual signal board before dense run rows')
assert(page.includes('sv-content-card') && page.includes('sv-muted-text') && page.includes('sv-accent-text'), 'SchedulerPage should consume the operations route surface tokens')
assert(page.indexOf('SchedulerCadenceChart') < page.indexOf('Daily Pipeline Chain'), 'Scheduler visual workbench should render before the pipeline DAG')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Scheduler chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Scheduler chart should use the accepted Apache-2.0 chart dependency')
