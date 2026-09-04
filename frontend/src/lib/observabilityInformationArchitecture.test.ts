import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'ObservabilityPage.tsx')
const chainPath = path.join(root, 'src', 'components', 'observability', 'ExecutionChainPanel.tsx')
const apiPath = path.join(root, 'src', 'lib', 'api.ts')
const chainCssPath = path.join(root, 'src', 'components', 'observability', 'ExecutionChainPanel.css')
const standalonePath = path.join(root, 'src', 'components', 'observability', 'StandaloneJobRegistry.tsx')
const standaloneCssPath = path.join(root, 'src', 'components', 'observability', 'StandaloneJobRegistry.css')
const attemptStatePath = path.join(root, 'src', 'components', 'observability', 'executionChainAttemptState.ts')
const removedChartPath = path.join(root, 'src', 'components', 'charts', 'ObservabilityEventTimeline.tsx')

const page = fs.readFileSync(pagePath, 'utf8').replace(/\r\n/g, '\n')
const chain = fs.readFileSync(chainPath, 'utf8').replace(/\r\n/g, '\n')
const api = fs.readFileSync(apiPath, 'utf8').replace(/\r\n/g, '\n')
const chainCss = fs.readFileSync(chainCssPath, 'utf8').replace(/\r\n/g, '\n')
const standalone = fs.readFileSync(standalonePath, 'utf8').replace(/\r\n/g, '\n')
const standaloneCss = fs.readFileSync(standaloneCssPath, 'utf8').replace(/\r\n/g, '\n')
const attemptState = fs.readFileSync(attemptStatePath, 'utf8').replace(/\r\n/g, '\n')

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

for (const scope of ['Daily readiness', 'Intraday guard', 'Weekly research', 'Monthly artifact']) {
  assert(chain.includes(scope), `execution chain must expose ${scope}`)
}
assert(!chain.includes("id: 'daily_ops'"), 'independent daily jobs must not be forced into a fake chain')
assert(chain.includes("relation: 'event'") && chain.includes("relation: 'mixed'"), 'chain must distinguish event-only and mixed-trigger scopes')
assert(chain.includes("['regime-compute'],") && chain.includes("['screener'],") && chain.indexOf("['regime-compute'],") < chain.indexOf("['screener'],") && chain.includes("['allocator-ev-readiness'],") && !chain.includes("['s12-structure-snapshot'],"), 'daily chain must expose indicator -> regime -> screener -> allocator without a duplicate S12 evening stage')
assert(chain.includes("id: 'weekly'"), 'weekly validation dependencies must retain their explicit evidence topology')
assert(chain.includes("orchestratorId: 'evening-chain'") && !chain.includes("      ['evening-chain'],"), 'Evening Chain must render as parent orchestration rather than an earlier sequential step')
assert(chain.includes('function scopeExecutionStageIds') && chain.includes('Parent orchestration · terminal callback'), 'parent orchestration must be excluded from step progress and explain terminal-callback ownership')
assert(chain.includes('const STATUS_ICON') && chain.includes('<StageStatusMarker status={status} />'), 'every chain plot must use a semantic Lucide status marker')
assert(chainCss.includes('.obs-chain__stage.is-completed .obs-chain__state-mark') && chainCss.includes('@keyframes obs-status-spin'), 'status markers must expose completed color/icon and meaningful running motion')
assert(chain.includes("['morning-setup'],") && chain.includes("['pre-market-warmup'],") && chain.includes("['intraday-check'],") && chain.includes("['eod-exit'],") && chain.includes("['post-close-price-refresh'],") && chain.includes("['daily-snapshot'],"), 'intraday main line must preserve verified readiness and post-close dependencies')
assert(chain.includes("id: 'premarket-context'") && chain.includes("['us-leading', 'news-analyst']") && chain.includes("['morning-briefing']") && chain.includes("relation: 'evidence'"), 'pre-market evidence producers must appear as a non-gating Intraday branch')
assert(chain.includes("id: 'intraday-rescore-spots'") && chain.includes("['rescore-10']") && chain.includes("['rescore-11']") && chain.includes("['rescore-12']") && chain.includes("['rescore-1230']") && chain.includes("relation: 'shared_context'"), 'Intraday Re-score must expose four independent status-bearing spots on a shared-context branch')
assert(chain.includes('function scopeStageIds') && chain.includes('scope.branches ?? []'), 'branch jobs must be included in mapped scheduler coverage')
assert(chain.includes("'context with' : 'shares inputs with'") && chain.includes('${mainStageCount} main') && chain.includes('${branchStageCount} branch'), 'branch UI must state shared-input semantics and avoid a fake sequential phase number')
assert(!chain.includes("'intraday-rescore': {") && !chain.includes('Next up') && !chain.includes('obs-chain__detail--next'), 'legacy aggregate re-score and redundant Next Up detail must stay removed')
assert(chainCss.includes('.obs-chain__branches') && chainCss.includes('.obs-chain__branch-sequence') && chainCss.includes('grid-template-columns: minmax(0,1fr)'), 'execution branches and single-column selected detail must have explicit responsive styling')
assert(chain.includes('obs-chain__topology is-${scope.id}') && chain.includes('Intraday main flow'), 'scope-specific topology classes must keep intraday branches and weekly compact layout explicit')
assert(chainCss.includes('grid-template-columns: minmax(210px,.68fr) minmax(620px,2.25fr) minmax(240px,.75fr)') && chainCss.includes('minmax(760px,2.7fr)') && chainCss.includes('.obs-chain__branch:nth-child(1)') && chainCss.includes('.obs-chain__branch:nth-child(2)'), 'desktop intraday topology must enlarge the main lane between pre-market left and re-score right')
assert(chain.includes("['model-ic-rolling']") && !chain.includes('buildScopedJobMap') && !chain.includes('model-ic-tracker'), 'daily chain must consume the isolated rolling identity without timestamp inference')
assert(chain.includes("job.id === 'intraday-check' && job.lastStatus === 'skip'") && chain.includes("noop: 'Checked · no action'"), 'an executed intraday heartbeat with no action must not look unexecuted')
assert(chain.includes("job.lastStatus === 'sleep') return 'out_of_window'") && chain.includes("out_of_window: 'Not in window'"), 'sleep must render as Not in window rather than Not started')
assert(chainCss.includes('.obs-chain__stage.is-out_of_window'), 'out-of-window stages must retain the neutral chain style')
assert(chain.includes('Monthly artifact chain'), 'monthly scope should own artifact cadence')
assert(chain.includes("['active8-oof-monthly']") && !chain.includes("'monthly-retrain':"), 'OBS monthly DAG must show only the canonical Active-8 release owner')
assert(chain.includes("id: 'post-close-evidence-extension'") && chain.includes("['dataset-snapshot-export']") && chain.includes("['active8-oof-daily']"), 'daily DAG must expose the durable detached snapshot -> Active-8 evidence branch')
assert(chain.includes("id: 'allocator-ev-lifecycle-recovery'") && chain.includes("['allocator-ev-lifecycle-watchdog']") && !chain.includes("      ['allocator-ev-lifecycle-watchdog'],\n      ['model-ic-rolling'],"), 'allocator EV lifecycle watchdog must render as an independent recovery branch, never as Verify callback downstream')
assert(chain.includes("'evening-closure':") && chain.includes("['evening-closure']") && chain.includes("next.get('evening-chain')"), 'daily DAG must end with a closure receipt backed by the real Evening root ticket')
assert(chain.includes('post-20a/20b closure receipt'), 'closure receipt must explain that it is the final root projection after both branches settle')
assert(chainCss.includes('.obs-chain__topology.is-daily_readiness .obs-chain__branches') && chainCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'daily evidence and shared-live branches must share one desktop row')
assert(chain.includes('function isExpectedEvidenceNoop') && chain.includes('Checked · awaiting maturity') && chain.includes('Checked · not applicable'), 'executed evidence no-ops must not render as unexplained skips')
assert(!chain.includes("['weekly-drift-retrain']") && !chain.includes("['storage-capacity-report']"), 'weekly/monthly DAG must not include nonexistent or daily-only jobs')
assert(chain.includes('duplicateScopeJobIds') && chain.includes('DUPLICATE_SCOPE_JOB_IDS'), 'one scheduler job must have exactly one cadence scope owner')
assert(chain.includes('Active-8 daily evidence') && chain.includes('Active-8 weekly cohort / validation-release') && chain.includes('Active-8 monthly release / validation'), 'Active-8 cadence roles must be visually distinct without claiming monthly-only promotion')
assert(!chain.includes("dependsOn: 'monthly-retrain'"), 'Active-8 monthly release must not depend on the retired universal retrain scheduler')
assert(api.includes("statusScope?: 'today' | 'historical_replay' | 'schedule'"), 'scheduler API must expose historical replay scope')
assert(api.includes('statusRunDate?: string | null'), 'scheduler API must expose the effective replay date')
assert(chain.includes('function statusLabel') && chain.includes('Historical replay · ${formatReplayDate(job.statusRunDate)} · ${label}'), 'historical replay stages must identify their effective date and runtime status')

assert(fs.existsSync(standalonePath) && fs.existsSync(standaloneCssPath), 'standalone job registry and isolated CSS should exist')
assert(chain.includes('StandaloneJobRegistry') && chain.includes('MAPPED_JOB_IDS'), 'execution chain must account for jobs outside visual topology')
assert(standalone.includes('.filter((job) => !mappedJobIds.has(job.id))'), 'every unmapped API job must enter the runtime registry')
assert(standalone.includes('Standalone root') && standalone.includes('Unmapped dependency') && standalone.includes('Dependency reviewed') && standalone.includes('Internal logical ticket'), 'registry must distinguish reviewed, standalone, unmapped, and internal task accounting')
assert(standalone.includes('logical accounted') && standalone.includes('ticket contract') && standalone.includes('observed') && standalone.includes('terminal'), 'registry must expose 52/52 logical accounting and contract/observed/terminal ticket coverage')
assert(standalone.includes("job.accounting?.physicalRoot") && standalone.includes("ticketLabel(job.ticket)"), 'registry cards must identify physical roots and runtime ticket presence')
assert(standalone.includes('function ticketLabel') && standalone.includes("ticket?.missing ? 'missing' : 'not required'"), 'registry must distinguish a required missing ticket from a manual task that does not require one')
assert(standaloneCss.includes('.obs-standalone__group-card') && standaloneCss.includes('.obs-standalone__job-grid') && !standaloneCss.includes('.obs-standalone__rows'), 'standalone jobs must use the previous grouped-card presentation')
assert(standalone.includes("['weekly', 'pipeline_chain', 'daily', 'intraday', 'monthly']") && standaloneCss.includes('grid-template-columns: repeat(12, minmax(0, 1fr));') && standaloneCss.includes("[aria-label='Weekly operations'] { grid-column: 1 / -1;") && standaloneCss.includes("[aria-label='Pipeline support'] { grid-column: span 4;") && standaloneCss.includes("[aria-label='Daily operations'] { grid-column: span 8;") && standaloneCss.includes("[aria-label='Daily operations'] .obs-standalone__job-grid") && standaloneCss.includes('grid-template-columns: repeat(4, minmax(0, 1fr));'), 'standalone desktop must place Pipeline support beside Daily operations while Daily keeps four cards per row')

assert(page.includes('schedulerApi.status'), 'execution chain must use the formal scheduler status API')
assert(page.includes('schedulerRefreshInterval(query.state.data?.jobs)'), 'scheduler refresh must adapt to runtime status')
assert(page.includes('refetchIntervalInBackground: false'), 'OBS realtime polling must stop when the page is in the background')
assert(chain.includes("return jobs?.some((job) => job.lastStatus === 'running') ? 3_000 : 15_000"), 'running chains must sync every 3s and idle chains every 15s')
assert(chain.includes('previousStatuses') && chain.includes('justCompleted'), 'callback success transition must trigger a completion visual')
assert(
  chain.includes('viewportRef')
    && chain.includes('viewport.scrollWidth <= viewport.clientWidth + 1')
    && chain.includes('viewport.scrollTo'),
  'current callback stage must focus only inside an overflowing chain viewport',
)
assert(
  chain.includes("scope.columns.length >= 16 ? 'is-dense' : ''")
    && chainCss.includes('.obs-chain__sequence.is-dense .obs-chain__connector')
    && chainCss.includes('overflow-x: hidden')
    && chainCss.includes('justify-content: space-between')
    && chainCss.includes('clamp(4px, .35vw, 9px)')
    && chainCss.includes('clamp(64px, 3.45vw, 92px)'),
  'long desktop chains must fill the viewport without a horizontal scrollbar or trailing blank block',
)

for (const animation of ['obs-running-breathe', 'obs-running-orbit', 'obs-completed-burst', 'obs-progress-flow', 'obs-progress-head']) {
  assert(chainCss.includes(`@keyframes ${animation}`), `missing execution-chain animation ${animation}`)
}
assert(chainCss.includes('.obs-chain__progress-fill.is-running'), 'Overall progress must animate while any stage is running')
assert(chain.includes('aria-current={currentId === id') && chain.includes("currentId === id ? 'is-current'"), 'current execution or death point must remain highlighted independently of selection')
assert(chain.includes('Running now') && chain.includes('No active runtime · latest checkpoint') && chain.includes('obs-chain__runtime'), 'toolbar must explicitly identify the current runtime or state that none is active')
assert(chain.includes("if (status === 'blocked') return 0") && chain.includes("if (status === 'running') return 1"), 'a primary blocker must remain the current death point while an independent recovery branch is running')
assert(chainCss.includes('@keyframes obs-death-beacon') && chainCss.includes('@keyframes obs-death-wave'), 'blocked current stage must expose a death-point animation')
assert(chainCss.includes('.obs-chain__progress-track.is-active::after') && chainCss.includes('@keyframes obs-progress-track-flow'), 'Overall progress track must retain a visible flow animation')
assert(chain.includes('JobStatusSummary') && chainCss.includes('.obs-chain__error-disclosure[open]'), 'long errors must use progressive disclosure instead of an internal scrollbar')
assert(chainCss.includes('-webkit-line-clamp: 3') && !chainCss.includes('max-height: 96px'), 'collapsed errors must clamp without restoring the removed scroll box')
assert(chainCss.includes('@media (prefers-reduced-motion: reduce)'), 'chain animations must respect reduced-motion preference')

assert(page.includes('const schedulerApiError = errorMessage(scheduler.error)'), 'Scheduler API error must remain first-class')
assert(
  page.includes('const readinessScore = Math.round(schedulerScore)') &&
    !page.includes('computeDataQualityScore') &&
    !page.includes('dataQualityScore * 0.48') &&
    !page.includes('>DQ {formatStatus'),
  'top readiness must represent scheduler execution only and must not revive retired DQ gating',
)
assert(page.includes('const dqChecks = dataQuality.data?.checks ?? []'), 'DQ evidence must remain available for operational drilldown')
assert(page.includes('aria-labelledby="source-gates-title"') && page.includes('<DataQualityCompactMatrix gates={gates} compact />'), 'full Source Gates must sit beside the readiness summary')
assert(page.includes('xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]') && page.includes("compact ? 'grid grid-cols-2 gap-2 lg:grid-cols-4'"), 'Readiness control and Source Gates must use a 4:6 desktop ratio with four Source Gate cards per row')
assert(page.includes('truncate text-sm font-semibold text-[#f2ead8]">Source Gates'), 'Source Gates must remain on the homepage StockIntelli typography baseline')
assert(chainCss.includes('background: linear-gradient(90deg, #171714, #111821 58%, #0b1118)') && chainCss.includes('font-size: .875rem') && chainCss.includes('color: #f2ead8'), 'Execution Chain must align to the Source Gates and homepage surface hierarchy')
assert(!page.includes('SourceGateSummary'), 'Source Gates must not collapse back into the replacement summary card')
assert(page.includes('/scheduler') && page.includes('/data-quality'), 'OBS must keep specialist drilldown links')
assert(!page.includes('text-[10px]') && !page.includes('text-[11px]'), 'OBS page should avoid tiny operational text')
assert(
  page.includes('xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]') &&
    page.includes('xl:grid-rows-[auto_minmax(0,1fr)]'),
  'Adaptive / Meta Evidence layout should remain intact',
)

assert(chain.includes('buildAttemptAwareJobMap') && chain.includes('inferOrchestratorStage'), 'active historical replay must derive its current stage from parent orchestration evidence')
assert(attemptState.includes("lastStatus: 'waiting'") && attemptState.includes('Previous-attempt terminal state is suppressed'), 'active replay must suppress stale downstream terminal states from an older attempt')
assert(chain.includes("recoveredFromStatus === 'failed'") && chain.includes('Recovered'), 'durably recovered callbacks must render as one recovered result instead of simultaneous red and green states')
assert(api.includes('statusAuthority?:') && api.includes('attemptCount?: number | null'), 'scheduler API must expose durable authority and retry count')

assert(
  attemptState.includes('directRunningStageId')
    && attemptState.includes('!directRunningStageId && !orchestratorRunning')
    && attemptState.includes('Current stage confirmed by its direct scheduler head.'),
  'direct stage running evidence must outrank a lagging parent orchestration hint',
)
console.log('observabilityInformationArchitecture: execution chain + standalone registry OK')
