import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const packageJsonPath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
const modelChartPath = path.join(root, 'src', 'components', 'charts', 'ModelPoolHealthChart.tsx')
const strategyChartPath = path.join(root, 'src', 'components', 'charts', 'StrategyExperimentTimeline.tsx')
const modelPoolPagePath = path.join(root, 'src', 'pages', 'ModelPoolPage.tsx')
const strategyLabPagePath = path.join(root, 'src', 'pages', 'StrategyLabPage.tsx')

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
  dependencies?: Record<string, string>
}
const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}

assert(packageJson.dependencies?.['lightweight-charts'] === '^5.2.0', 'P0 workstation charts should pin lightweight-charts to the accepted 5.2.x line')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'package-lock should resolve lightweight-charts to 5.2.0')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'lightweight-charts license should remain the explicitly accepted Apache-2.0')

assert(fs.existsSync(modelChartPath), 'ModelPoolHealthChart component should exist')
assert(fs.existsSync(strategyChartPath), 'StrategyExperimentTimeline component should exist')

const modelChart = fs.readFileSync(modelChartPath, 'utf8')
assert(modelChart.includes("from 'lightweight-charts'"), 'ModelPoolHealthChart should use lightweight-charts')
assert(modelChart.includes('LineSeries'), 'ModelPoolHealthChart should render IC line series')
assert(modelChart.includes('HistogramSeries'), 'ModelPoolHealthChart should render sample/coverage histogram')
assert(modelChart.includes('createSeriesMarkers'), 'ModelPoolHealthChart should render lifecycle markers')
assert(modelChart.includes('ML Pool Visual Workbench'), 'ModelPoolHealthChart empty state should still render a visible visual workbench')
assert(modelChart.includes("model.status === 'active' || model.status === 'degraded'"), 'ModelPoolHealthChart should include degraded production slots as serving alpha models')
assert(modelChart.includes('Production alpha slots evidence surface'), 'ModelPoolHealthChart title should describe serving alpha slots, not active-only lineage')

const strategyChart = fs.readFileSync(strategyChartPath, 'utf8')
assert(strategyChart.includes("from 'lightweight-charts'"), 'StrategyExperimentTimeline should use lightweight-charts')
assert(strategyChart.includes('LineSeries'), 'StrategyExperimentTimeline should render match-rate line series')
assert(strategyChart.includes('HistogramSeries'), 'StrategyExperimentTimeline should render sample histograms')
assert(strategyChart.includes('createSeriesMarkers'), 'StrategyExperimentTimeline should render experiment markers')
assert(strategyChart.includes('Strategy Visual Workbench'), 'StrategyExperimentTimeline empty state should still render a visible visual workbench')

const modelPoolPage = fs.readFileSync(modelPoolPagePath, 'utf8')
assert(modelPoolPage.includes('Model Health Matrix'), 'ModelPool page should render the unified model health matrix')
assert(!modelPoolPage.includes('<Model' + 'PoolHealthChart'), 'ModelPool page should not render a duplicate model health chart above the serving matrix')
assert(!modelPoolPage.includes('Model Ops Mission Control'), 'ModelPool page should not render the duplicate Model Ops Mission Control panel')
assert(!modelPoolPage.includes('ServingAlphaStrip'), 'ModelPool page should not render a duplicate serving alpha strip')
assert(modelPoolPage.includes('Serving Alpha Slots'), 'ModelPool KPI should use Serving Alpha Slots wording')
assert(!modelPoolPage.includes('<Family' + 'BalancePanel'), 'ModelPool page should not render a standalone FamilyBalancePanel')
assert(!modelPoolPage.includes('<Champion' + 'PointerPanel'), 'Champion pointer readiness should be merged into the serving strip instead of a duplicate panel')
assert(modelPoolPage.includes('effectiveVoteWeight'), 'Model health matrix should expose effective vote weight for active and degraded models')
assert(!modelPoolPage.includes('<Mini' + 'Sparkline'), 'Serving alpha matrix should not show unlabeled mini bar charts inside model cards')

const strategyLabPage = fs.readFileSync(strategyLabPagePath, 'utf8')
assert(strategyLabPage.includes('StrategyExperimentTimeline'), 'Strategy Lab page should render the experiment timeline')
assert(
  strategyLabPage.indexOf('StrategyExperimentTimeline') < strategyLabPage.indexOf('{error &&'),
  'Strategy Lab should render the visual workbench before API error text so the page does not look unchanged when APIs fail',
)
