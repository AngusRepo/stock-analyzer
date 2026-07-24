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

for (const scope of ['Daily readiness', 'Intraday guard', 'Monthly artifact']) {
  assert(chain.includes(scope), `execution chain must expose ${scope}`)
}
assert(!chain.includes("id: 'daily_ops'"), 'independent daily jobs must not be forced into a fake chain')
assert(chain.includes("relation: 'event'") && chain.includes("relation: 'mixed'"), 'chain must distinguish event-only and mixed-trigger scopes')
assert(chain.includes("['screener', 'regime-compute', 'allocator-ev-readiness']"), 'daily chain must render the parallel pre-pipeline readiness branch')
assert(!chain.includes("id: 'weekly'"), 'schedule-driven weekly jobs must stay in grouped inventory rather than a fake dependency chain')
assert(chain.includes("['morning-setup'],") && chain.includes("['pre-market-warmup'],") && chain.includes("['intraday-check'],"), 'intraday chain must retain only verified morning readiness dependencies')
assert(chain.includes("['model-ic-rolling']") && !chain.includes('buildScopedJobMap') && !chain.includes('model-ic-tracker'), 'daily chain must consume the isolated rolling identity without timestamp inference')
assert(chain.includes("job.id === 'intraday-check' && job.lastStatus === 'skip'") && chain.includes("noop: 'Checked · no action'"), 'an executed intraday heartbeat with no action must not look unexecuted')
assert(chain.includes('Monthly artifact chain'), 'monthly scope should own artifact cadence')

assert(fs.existsSync(standalonePath) && fs.existsSync(standaloneCssPath), 'standalone job registry and isolated CSS should exist')
assert(chain.includes('StandaloneJobRegistry') && chain.includes('MAPPED_JOB_IDS'), 'execution chain must account for jobs outside visual topology')
assert(standalone.includes('.filter((job) => !mappedJobIds.has(job.id))'), 'every unmapped API job must enter the runtime registry')
assert(standalone.includes('Standalone root') && standalone.includes('Unmapped dependency'), 'registry must distinguish independent jobs from missing topology')
assert(standalone.includes('{jobs.length} / {jobs.length} accounted'), 'registry must expose full scheduler coverage')
assert(standaloneCss.includes('.obs-standalone__group-card') && standaloneCss.includes('.obs-standalone__job-grid'), 'standalone jobs must use the approved grouped block presentation')

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
assert(chain.includes('aria-current={currentId === id') && chain.includes("currentId === id ? 'is-current'"), 'current execution or death point must remain highlighted independently of selection')
assert(chainCss.includes('@keyframes obs-death-beacon') && chainCss.includes('@keyframes obs-death-wave'), 'blocked current stage must expose a death-point animation')
assert(chainCss.includes('.obs-chain__progress-track.is-active::after') && chainCss.includes('@keyframes obs-progress-track-flow'), 'Overall progress track must retain a visible flow animation')
assert(chain.includes('JobStatusSummary') && chainCss.includes('.obs-chain__error-disclosure[open]'), 'long errors must use progressive disclosure instead of an internal scrollbar')
assert(chainCss.includes('-webkit-line-clamp: 3') && !chainCss.includes('max-height: 96px'), 'collapsed errors must clamp without restoring the removed scroll box')
assert(chainCss.includes('@media (prefers-reduced-motion: reduce)'), 'chain animations must respect reduced-motion preference')

assert(page.includes('const schedulerApiError = errorMessage(scheduler.error)'), 'Scheduler API error must remain first-class')
assert(page.includes('aria-label="Source gates summary"') && page.includes('<SourceGateSummary gates={gates} />'), 'Source Gates must sit in the top readiness summary row')
assert(page.includes('md:grid-cols-2 2xl:grid-cols-4'), 'current stage, cadence, data gate, and Source Gates must share a four-column desktop row')
assert(page.includes('/scheduler') && page.includes('/data-quality'), 'OBS must keep specialist drilldown links')
assert(!page.includes('text-[10px]') && !page.includes('text-[11px]'), 'OBS page should avoid tiny operational text')
assert(
  page.includes('xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]') &&
    page.includes('xl:grid-rows-[auto_minmax(0,1fr)]'),
  'Adaptive / Meta Evidence layout should remain intact',
)

console.log('observabilityInformationArchitecture: execution chain + standalone registry OK')
