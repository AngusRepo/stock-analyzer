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
assert(page.includes('function SchedulerSourceGateBoard'), 'OBS should render scheduler group cards as the Source Gates scheduler board')
assert(page.includes('<DataQualityCompactMatrix gates={gates} />\n          <SchedulerSourceGateBoard jobs={jobs} />'), 'OBS should place scheduler group cards directly under Source Gates / data readiness')
assert(!page.includes('SchedulerInventoryPanel'), 'OBS should not render scheduler group cards as a separate bottom inventory block')
assert(!page.includes('SchedulerReadinessGroupBoard'), 'OBS should use one Source Gates scheduler board implementation')
assert(
  page.includes("const SCHEDULER_GROUP_ORDER: SchedulerJob['group'][] = ['pipeline_chain', 'daily', 'intraday', 'monthly', 'weekly']"),
  'Daily standalone should sit immediately to the right of Daily readiness chain in the Source Gates scheduler row',
)
assert(
  page.includes("if (group === 'pipeline_chain') return '2xl:row-span-3'") &&
    page.includes("if (group === 'weekly') return '2xl:col-span-2'"),
  'Source Gates scheduler board should stack Intraday and Monthly under Daily standalone, while Weekly spans a full row',
)
assert(
  page.includes('xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]') &&
    page.includes('xl:grid-rows-[auto_minmax(0,1fr)]'),
  'Adaptive / Meta Evidence should stack Threshold Policy over LinUCB Guard on the left and align with GA Promotion on the right',
)
