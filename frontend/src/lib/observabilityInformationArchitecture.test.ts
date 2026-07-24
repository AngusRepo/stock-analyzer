import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'ObservabilityPage.tsx')
const chainPath = path.join(root, 'src', 'components', 'observability', 'ExecutionChainPanel.tsx')
const chainCssPath = path.join(root, 'src', 'components', 'observability', 'ExecutionChainPanel.css')
const standalonePath = path.join(root, 'src', 'components', 'observability', 'StandaloneJobRegistry.tsx')
const standaloneCssPath = path.join(root, 'src', 'components', 'observability', 'StandaloneJobRegistry.css')
const removedChartPath = path.join(root, 'src', 'components', 'charts', 'ObservabilityEventTimeline.tsx')

const page = fs.readFileSync(pagePath, 'utf8').replace(/\r\n/g, '\n')
const chain = fs.readFileSync(chainPath, 'utf8').replace(/\r\n/g, '\n')
const chainCss = fs.readFileSync(chainCssPath, 'utf8').replace(/\r\n/g, '\n')
const standalone = fs.readFileSync(standalonePath, 'utf8').replace(/\r\n/g, '\n')
const standaloneCss = fs.readFileSync(standaloneCssPath, 'utf8').replace(/\r\n/g, '\n')

assert(!fs.existsSync(removedChartPath), 'OBS severity timeline chart should remain removed')
assert(!page.includes('ObservabilityEventTimeline'), 'ObservabilityPage should not render the removed severity timeline')
assert(page.includes('AdaptiveMetaPanel'), 'ObservabilityPage should keep adaptive/GA evidence')
assert(page.includes("event.domain === 'ml_threshold_policy'"), 'OBS adaptive/meta panel must consume ml_threshold_policy events')
assert(page.includes('Operational Drilldown'), 'ObservabilityPage should keep actionable operations evidence')
assert(page.includes('Loading OBS evidence'), 'OBS should keep its loading transition')

assert(fs.existsSync(chainPath) && fs.existsSync(chainCssPath), 'OBS execution chain component and isolated CSS should exist')
assert(page.includes('ExecutionChainPanel'), 'OBS should render the formal execution chain')
assert(page.includes('<ExecutionChainPanel'), 'OBS should mount the execution chain in the readiness deck')
assert(!page.includes('<ReadinessFlowMap'), 'OBS should no longer render the old step-card readiness map')
assert(!page.includes('<SchedulerReadinessGroupBoard'), 'OBS should no longer render the scheduler card wall')
assert(!page.includes('<SchedulerShortcutDeck'), 'Source Gates should not duplicate scheduler scope cards')

for (const scope of ['Daily readiness', 'Intraday', 'Weekly validation', 'Monthly artifact']) {
  assert(chain.includes(scope), `execution chain must expose ${scope}`)
}
assert(!chain.includes("id: 'daily_ops'"), 'independent daily jobs must not be forced into a fake chain')
assert(chain.includes("relation: 'event'") && chain.includes("relation: 'mixed'"), 'chain must distinguish event-only and mixed-trigger scopes')
assert(chain.includes("['screener', 'regime-compute', 'allocator-ev-readiness']"), 'daily chain must render the parallel pre-pipeline readiness branch')
assert(chain.includes("['weekly-backtest', 'alpha-quality', 'model-ic-tracker']"), 'weekly chain must render parallel validation evidence')
assert(chain.includes('Monthly artifact chain'), 'monthly scope should own artifact cadence')
assert(chain.includes('不把 weekly 當 artifact promotion'), 'weekly scope must remain drift/validation rather than artifact promotion')

assert(fs.existsSync(standalonePath) && fs.existsSync(standaloneCssPath), 'standalone job registry and isolated CSS should exist')
assert(chain.includes('StandaloneJobRegistry') && chain.includes('MAPPED_JOB_IDS'), 'execution chain must account for jobs outside visual topology')
assert(standalone.includes('.filter((job) => !mappedJobIds.has(job.id))'), 'every unmapped API job must enter the runtime registry')
assert(standalone.includes('Standalone root') && standalone.includes('Unmapped dependency'), 'registry must distinguish independent jobs from missing topology')
assert(standalone.includes('{jobs.length} / {jobs.length} accounted'), 'registry must expose full scheduler coverage')
assert(standaloneCss.includes('.obs-standalone__row'), 'standalone jobs should use compact rows instead of another card wall')

assert(page.includes('schedulerApi.status'), 'execution chain must use the formal scheduler status API')
assert(page.includes('schedulerRefreshInterval(query.state.data?.jobs)'), 'scheduler refresh must adapt to runtime status')
assert(page.includes('refetchIntervalInBackground: false'), 'OBS realtime polling must stop when the page is in the background')
assert(chain.includes("return jobs?.some((job) => job.lastStatus === 'running') ? 3_000 : 15_000"), 'running chains must sync every 3s and idle chains every 15s')
assert(chain.includes('previousStatuses') && chain.includes('justCompleted'), 'callback success transition must trigger a completion visual')
assert(chain.includes('scrollIntoView') && chain.includes('currentId'), 'current callback stage must auto-focus when it changes')

for (const animation of ['obs-running-breathe', 'obs-running-orbit', 'obs-completed-burst', 'obs-progress-flow', 'obs-progress-head']) {
  assert(chainCss.includes(`@keyframes ${animation}`), `missing execution-chain animation ${animation}`)
}
assert(chainCss.includes('.obs-chain__progress-fill.is-running'), 'Overall progress must animate while any stage is running')
assert(chainCss.includes('@media (prefers-reduced-motion: reduce)'), 'chain animations must respect reduced-motion preference')

assert(page.includes('const schedulerApiError = errorMessage(scheduler.error)'), 'Scheduler API error must remain first-class')
assert(page.includes('DataQualityCompactMatrix gates={gates}'), 'Source Gates must retain compact data-quality evidence')
assert(page.includes('/scheduler') && page.includes('/data-quality'), 'OBS must keep specialist drilldown links')
assert(!page.includes('text-[10px]') && !page.includes('text-[11px]'), 'OBS page should avoid tiny operational text')
assert(
  page.includes('xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]') &&
    page.includes('xl:grid-rows-[auto_minmax(0,1fr)]'),
  'Adaptive / Meta Evidence layout should remain intact',
)

console.log('observabilityInformationArchitecture: execution chain + standalone registry OK')
