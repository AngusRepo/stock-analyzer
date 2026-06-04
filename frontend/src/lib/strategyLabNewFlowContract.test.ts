import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'StrategyLabPage.tsx')
const workbenchPath = path.join(root, 'src', 'components', 'strategy-lab', 'StrategyFamilyWorkbench.tsx')

assert(fs.existsSync(workbenchPath), 'StrategyFamilyWorkbench should exist for L1 family / variant governance')

const page = fs.readFileSync(pagePath, 'utf8')
const workbench = fs.readFileSync(workbenchPath, 'utf8')

assert(page.includes("import StrategyFamilyWorkbench from '@/components/strategy-lab/StrategyFamilyWorkbench'"), 'StrategyLab page should import the L1 family cockpit')
assert(page.includes('<StrategyFamilyWorkbench'), 'StrategyLab page should render the L1 family cockpit')
assert(page.indexOf('<StrategyFamilyWorkbench') < page.indexOf('<StrategyExperimentTimeline'), 'L1 family cockpit should render before experiment timeline')

assert(workbench.includes("from 'lightweight-charts'"), 'Strategy family cockpit should use lightweight-charts')
assert(workbench.includes('HistogramSeries'), 'Strategy family cockpit should render matched-count histograms')
assert(workbench.includes('LineSeries'), 'Strategy family cockpit should render learning hit-rate lines')
assert(workbench.includes('createSeriesMarkers'), 'Strategy family cockpit should render family markers')

for (const familyId of [
  'VOLATILITY_CONTRACTION_BREAKOUT',
  'TREND_RECLAIM_CONTINUATION',
  'SMART_MONEY_ACCUMULATION',
  'SMC_STRUCTURE_RECLAIM',
  'REVENUE_QUALITY_MOMENTUM',
  'SECTOR_ROTATION_CORE',
]) {
  assert(workbench.includes(familyId), `${familyId} should be represented in the L1 family cockpit`)
}

assert(workbench.includes('raw top-up'), 'Strategy family cockpit should explicitly separate strategy-hit breadth from raw top-up')
assert(workbench.includes('Model Pool'), 'Strategy family cockpit should hand off L2/L3 model concerns to Model Pool')

console.log('strategyLabNewFlowContract: OK')
