import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const chartPath = path.join(root, 'src', 'components', 'charts', 'DailyPipelineRunLane.tsx')
const pagePath = path.join(root, 'src', 'pages', 'PipelinePage.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

assert(!fs.existsSync(chartPath), 'DailyPipelineRunLane should stay deleted; the old funnel/run-lane chart was removed as low-signal UI')

const page = fs.readFileSync(pagePath, 'utf8')
assert(!page.includes('DailyPipelineRunLane'), 'PipelinePage must not render the deleted run lane')
assert(!page.includes('CandidateSourceMixChart'), 'PipelinePage must not render the deleted candidate source mix chart')
assert(!page.includes('SingleStockTrace'), 'PipelinePage must not bring back the duplicate single-stock trace panel')
assert(page.includes('buildScreenerSectorSummary('), 'PipelinePage should keep sector selection reasons in the bottom-up screener block')
assert(page.includes('DebateTurnsList'), 'PipelinePage should keep debate turns attached to each T2 pending buy row')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Chart surfaces should keep the accepted lightweight-charts 5.2.0 dependency')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Chart surfaces should keep the accepted Apache-2.0 chart dependency')
