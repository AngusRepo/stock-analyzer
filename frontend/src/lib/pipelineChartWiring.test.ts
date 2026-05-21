import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'PipelinePage.tsx')
const packageLockPath = path.join(root, 'package-lock.json')

const page = fs.readFileSync(pagePath, 'utf8')
assert(!page.includes('DailyPipelineRunLane'), 'PipelinePage should not render the removed candidate funnel run lane')
assert(!page.includes('CandidateSourceMixChart'), 'PipelinePage should not render the removed low-signal candidate source mix chart')
assert(page.includes('StockSelectionTracePanel'), 'PipelinePage should keep the decision trace surface')
assert(page.includes('PendingBuyHistoryPanel'), 'PipelinePage should keep the same-day debate surface')

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8')) as {
  packages?: Record<string, { license?: string; version?: string }>
}
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'Accepted lightweight-charts dependency should remain available for useful charts')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'Accepted Apache-2.0 chart dependency should remain locked')
