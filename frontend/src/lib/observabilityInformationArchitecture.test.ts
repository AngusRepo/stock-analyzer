import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'ObservabilityPage.tsx')
const removedChartPath = path.join(root, 'src', 'components', 'charts', 'ObservabilityEventTimeline.tsx')
const page = fs.readFileSync(pagePath, 'utf8')

assert(!fs.existsSync(removedChartPath), 'OBS severity timeline chart should stay removed; it duplicated event counts without decision value')
assert(!page.includes('ObservabilityEventTimeline'), 'ObservabilityPage should not render the removed severity timeline')
assert(page.includes('Loading OBS evidence'), 'OBS should show a loading transition before rendering empty evidence frames')
assert(page.includes('Active Blockers'), 'OBS should put active blockers ahead of healthy inventory')
assert(page.includes('buildObsBlockers') && page.includes('blockerRootKey'), 'OBS should deduplicate blockers by normalized root cause')
assert(page.includes('Blocker Inspector') && page.includes("url.searchParams.set('blocker', id)"), 'OBS should keep a URL-keyed persistent blocker inspector')
assert(page.includes('唯一下一步'), 'Selected blocker should expose one evidence-driven next action')
assert(page.includes("status: 'NEW' | 'ACK'") && page.includes('Acknowledge'), 'OBS should support lightweight NEW/ACK triage without enterprise on-call semantics')
assert(page.includes('Operational Drilldown / Readiness Snapshot'), 'OBS should preserve a compact readiness path below active blockers')
assert(page.includes('<DataQualityCompactMatrix gates={gates} />') && page.includes('<SchedulerShortcutDeck jobs={jobs} schedulerApiError={schedulerApiError} />'), 'Source Gates should keep compact DQ and scheduler evidence')
assert(page.includes('Healthy / Scheduler Inventory') && page.includes('<details open={blockers.length === 0}'), 'Detailed scheduler inventory should be collapsed while blockers are active')
assert(page.includes('<SchedulerReadinessGroupBoard jobs={jobs} schedulerApiError={schedulerApiError} />'), 'Collapsed inventory should retain the complete scheduler group board')
assert(page.includes('Adaptive / Meta runtime evidence') && page.includes('<details open={adaptiveBlocking}'), 'Adaptive/meta evidence should expand only when it blocks production readiness')
assert(page.includes("event.domain === 'ml_threshold_policy'"), 'OBS adaptive/meta evidence must consume ml_threshold_policy runtime events')
assert(page.includes('Runtime ML threshold policy'), 'OBS should display runtime ML threshold policy provenance')
assert(page.includes('L3 blockers:'), 'GA panel should explicitly show the remaining L3 blocker')
assert(page.includes('ready for approval'), 'GA panel should distinguish L3-ready evidence from approval')
assert(page.includes('Request {nextLevel} review') && page.includes('Approve {pendingApprovalLevel}'), 'GA panel should retain guarded review actions')
assert(page.includes('const schedulerApiError = errorMessage(scheduler.error)'), 'Scheduler API failure must remain a first-class blocker')
assert(!page.includes('source-readiness-probe'), 'OBS must not reference the retired source-readiness-probe scheduler id')
assert(!page.includes('text-[10px]') && !page.includes('text-[11px]'), 'OBS should avoid tiny 10/11px operational text')

console.log('observabilityInformationArchitecture: OK')
