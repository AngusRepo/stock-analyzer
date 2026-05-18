import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'ObservabilityPage.tsx')
const removedChartPath = path.join(root, 'src', 'components', 'charts', 'ObservabilityEventTimeline.tsx')

const page = fs.readFileSync(pagePath, 'utf8')

assert(!fs.existsSync(removedChartPath), 'OBS severity timeline chart should be removed; it duplicated event counts without decision value')
assert(!page.includes('ObservabilityEventTimeline'), 'ObservabilityPage should not render the removed severity timeline')
assert(page.includes('AdaptiveMetaPanel'), 'ObservabilityPage should keep adaptive/GA evidence as the primary visual diagnostic surface')
assert(page.includes('Operational Drilldown'), 'ObservabilityPage should keep drilldown rows for actionable operations evidence')
assert(page.includes('L3 blockers:'), 'GA panel should explicitly show the remaining L3 blocker instead of only OK evidence pills')
assert(page.includes('ready for approval'), 'GA panel should distinguish L3-ready evidence from actual approval')
