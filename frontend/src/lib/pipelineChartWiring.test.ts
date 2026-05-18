import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartPath = path.join(root, 'src', 'components', 'charts', 'DailyPipelineRunLane.tsx')
const pagePath = path.join(root, 'src', 'pages', 'PipelinePage.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(fs.existsSync(chartPath), 'DailyPipelineRunLane component should exist')

const chart = fs.readFileSync(chartPath, 'utf8')
assert(chart.includes("from 'lightweight-charts'"), 'DailyPipelineRunLane should use lightweight-charts')
assert(chart.includes('LineSeries'), 'DailyPipelineRunLane should render a candidate funnel line')
assert(chart.includes('HistogramSeries'), 'DailyPipelineRunLane should render attrition / blocker bars')
assert(chart.includes('createSeriesMarkers'), 'DailyPipelineRunLane should render fallback / human-review markers')
assert(chart.includes('Pipeline Visual Workbench'), 'DailyPipelineRunLane should render a visible visual workbench')
assert(chart.includes('buildPipelineStages('), 'DailyPipelineRunLane should build stages from current API payloads')
assert(chart.includes('quadrantFilters'), 'DailyPipelineRunLane should include RRG quadrant filter evidence')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('DailyPipelineRunLane'), 'PipelinePage should render DailyPipelineRunLane')
assert(page.includes('recommendations={allRecs}'), 'PipelinePage should pass daily recommendations into the run lane')
assert(page.includes('pendingBuys={pendingBuys}'), 'PipelinePage should pass pending buys into the run lane')
assert(page.includes('quadrantFilters={qfList}'), 'PipelinePage should pass quadrant filter evidence into the run lane')
assert(page.includes('loading={isLoading}'), 'PipelinePage should pass loading state into the run lane')
assert(page.indexOf('DailyPipelineRunLane') < page.indexOf('Pipeline flow indicator'), 'Pipeline visual workbench should render before the old flow indicator')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Pipeline chart should use the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Pipeline chart should use the accepted Apache-2.0 chart dependency')
