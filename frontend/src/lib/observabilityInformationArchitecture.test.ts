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
assert(page.includes('function SchedulerShortcutDeck'), 'OBS should keep the five compact scheduler shortcut cards')
assert(
  page.includes('<DataQualityCompactMatrix gates={gates} />\n          <SchedulerShortcutDeck jobs={jobs} schedulerApiError={schedulerApiError} />'),
  'OBS should place the five compact scheduler cards inside Source Gates / data readiness',
)
assert(page.includes('<ReadinessFlowMap stages={stages} />\n        </div>'), 'Readiness Flow should not own the compact scheduler card row')
assert(page.includes('function SchedulerReadinessGroupBoard'), 'OBS should render detailed scheduler group cards as the row below Readiness Flow and Source Gates')
assert(
  page.includes('</div>\n      <SchedulerReadinessGroupBoard jobs={jobs} schedulerApiError={schedulerApiError} />\n    </div>'),
  'Detailed Daily readiness and Daily standalone cards should sit below the two top readiness/source-gate cards',
)
assert(page.includes('const schedulerApiError = errorMessage(scheduler.error)'), 'OBS must keep the scheduler status API error as a first-class signal')
assert(page.includes('Scheduler API') && page.includes('schedulerApiError'), 'OBS scheduler cards must show the real Scheduler API error instead of only expected job skeletons')
assert(page.includes("schedulerApiError ? 'API ERROR'"), 'OBS scheduler group badges must not label API failures as expected schedulers')
assert(!page.includes('SchedulerSourceGateBoard'), 'OBS should not embed detailed scheduler group cards inside Source Gates')
assert(!page.includes('SchedulerInventoryPanel'), 'OBS should not render scheduler group cards as a separate bottom inventory block')
assert(
  page.includes('group="pipeline_chain"') &&
    page.includes('group="daily"') &&
    page.includes('group="intraday"') &&
    page.includes('group="monthly"') &&
    page.includes('group="weekly"'),
  'Detailed scheduler board should keep Daily readiness, Daily standalone, Intraday, Monthly, and Weekly visible',
)
assert(
  page.includes('<div className="grid min-w-0 gap-3 xl:grid-cols-2">') &&
    page.includes('<SchedulerGroupCard group="intraday"') &&
    page.includes('<SchedulerGroupCard group="monthly"') &&
    page.includes('group="weekly"') &&
    page.includes('className="2xl:col-span-2"'),
  'Detailed scheduler board should place Intraday and Monthly under Daily standalone, while Weekly spans the full next row',
)
assert(
  page.includes('xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]') &&
    page.includes('xl:grid-rows-[auto_minmax(0,1fr)]'),
  'Adaptive / Meta Evidence should stack Threshold Policy over LinUCB Guard on the left and align with GA Promotion on the right',
)
