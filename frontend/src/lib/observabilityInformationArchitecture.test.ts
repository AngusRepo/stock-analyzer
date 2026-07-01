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
assert(page.includes('Request {nextLevel} review'), 'GA panel should expose a clickable L3/L4 review request action')
assert(page.includes('Approve {pendingApprovalLevel}'), 'GA panel should expose a clickable pending GA approval action')
assert(page.includes('Loading OBS evidence'), 'OBS should show a loading transition before rendering empty evidence frames')
assert(page.includes('function SchedulerInventoryPanel'), 'OBS should keep scheduler group cards in the Scheduler Inventory section')
assert(page.includes('<SchedulerInventoryPanel jobs={jobs} />'), 'OBS should render Scheduler Inventory below the readiness/source-gate row')
assert(!page.includes('SchedulerReadinessGroupBoard'), 'OBS Source Gates should not embed the full daily/intraday/weekly/monthly scheduler group board')
assert(
  page.includes("const SCHEDULER_GROUP_ORDER: SchedulerJob['group'][] = ['pipeline_chain', 'daily', 'intraday', 'weekly', 'monthly']"),
  'Daily standalone should sit immediately to the right of Daily readiness chain in Scheduler Inventory',
)
assert(
  page.includes("if (group === 'pipeline_chain' || group === 'daily') return '2xl:col-span-2'"),
  'Daily readiness chain and Daily standalone should share the first Scheduler Inventory row on wide screens',
)
