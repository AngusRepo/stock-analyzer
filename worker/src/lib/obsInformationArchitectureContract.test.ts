import * as fs from 'node:fs'
import * as path from 'node:path'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')
const appShell = fs.readFileSync(path.join(frontend, 'components', 'AppShell.tsx'), 'utf8')
const obs = fs.readFileSync(path.join(frontend, 'pages', 'ObservabilityPage.tsx'), 'utf8')
const executionChain = fs.readFileSync(path.join(frontend, 'components', 'observability', 'ExecutionChainPanel.tsx'), 'utf8')
const executionChainCss = fs.readFileSync(path.join(frontend, 'components', 'observability', 'ExecutionChainPanel.css'), 'utf8')
const standaloneJobs = fs.readFileSync(path.join(frontend, 'components', 'observability', 'StandaloneJobRegistry.tsx'), 'utf8')
const standaloneJobsCss = fs.readFileSync(path.join(frontend, 'components', 'observability', 'StandaloneJobRegistry.css'), 'utf8')
const scheduler = fs.readFileSync(path.join(frontend, 'pages', 'SchedulerPage.tsx'), 'utf8')
const dataQuality = fs.readFileSync(path.join(frontend, 'pages', 'DataQualityPage.tsx'), 'utf8')

assert(appShell.includes("href: '/obs'"), 'OBS must remain the main observability entry in sidebar')
assert(appShell.includes("href: '/model-pool'"), 'Model Pool must remain a specialist lifecycle explorer in sidebar')
assert(!appShell.includes("href: '/scheduler'"), 'Scheduler must remain an OBS drilldown rather than a primary sidebar item')
assert(!appShell.includes("href: '/data-quality'"), 'Data Quality must remain an OBS drilldown rather than a primary sidebar item')

assert(!obs.includes('Incident Inbox'), 'OBS must not restore the duplicate incident inbox')
assert(!obs.includes('Selected Incident Detail'), 'OBS must not restore the old selected-incident pane')
assert(!obs.includes('Reliability Map'), 'OBS must not render the low-signal reliability map')
assert(obs.includes('computeDataQualityScore'), 'OBS Data Quality score must be computed from checks')
assert(!obs.includes('setActiveTab'), 'OBS must not expose fake content tabs')

assert(obs.includes('ExecutionChainPanel'), 'OBS must render the callback-driven execution chain')
assert(!obs.includes('<ReadinessFlowMap'), 'OBS must not render the old readiness step-card grid')
assert(!obs.includes('<SchedulerReadinessGroupBoard'), 'OBS must not render the old scheduler card wall')
assert(!obs.includes('<SchedulerShortcutDeck'), 'OBS Source Gates must not duplicate scheduler scope cards')
assert(executionChain.includes("['screener', 'regime-compute', 'allocator-ev-readiness']"), 'daily execution chain must preserve the parallel readiness join')
assert(!executionChain.includes("id: 'daily_ops'"), 'independent scheduled roots must not be represented as a fake daily chain')
assert(executionChain.includes('Weekly validation') && executionChain.includes('Monthly artifact'), 'execution chain must keep validated weekly and monthly scopes')
assert(executionChain.includes('StandaloneJobRegistry') && executionChain.includes('MAPPED_JOB_IDS'), 'execution chain must route non-chain jobs into the registry')
assert(standaloneJobs.includes('.filter((job) => !mappedJobIds.has(job.id))'), 'all unmapped scheduler API jobs must remain visible')
assert(standaloneJobs.includes('Standalone root') && standaloneJobs.includes('Unmapped dependency'), 'registry must not confuse independent jobs with missing topology')
assert(standaloneJobs.includes('{jobs.length} / {jobs.length} accounted'), 'OBS must account for the full scheduler API universe')
assert(standaloneJobsCss.includes('.obs-standalone__row'), 'standalone registry must use compact rows rather than a card wall')
assert(executionChain.includes("lastStatus === 'running') ? 3_000 : 15_000"), 'callback sync must be 3s while running and 15s while idle')
assert(executionChain.includes('previousStatuses') && executionChain.includes('justCompleted'), 'final callback must trigger a completed-stage transition')
assert(executionChainCss.includes('@keyframes obs-running-orbit'), 'running stage must have an attention animation')
assert(executionChainCss.includes('@keyframes obs-progress-flow'), 'Overall progress must animate during active execution')
assert(executionChainCss.includes('prefers-reduced-motion'), 'OBS animation must respect reduced-motion accessibility')

assert(obs.includes('Data Quality'), 'OBS must keep compact Data Quality evidence')
assert(!obs.includes('Model Health Snapshot'), 'OBS must not duplicate Model Pool health')
assert(!obs.includes('Cost / Resource'), 'OBS must not render low-signal resource blocks')
assert(obs.includes('/scheduler') && obs.includes('/data-quality'), 'OBS must keep specialist route deep links')

assert(scheduler.includes('Scheduler Drilldown'), 'Scheduler deep link should remain a drilldown')
assert(!scheduler.includes('dataQualityApi') && !scheduler.includes('deployGateApi') && !scheduler.includes('costsApi'), 'Scheduler drilldown must not duplicate other ownership')
assert(dataQuality.includes('Data Quality Drilldown'), 'Data Quality deep link should remain a drilldown')
assert(dataQuality.includes('freshness') && dataQuality.includes('schema') && dataQuality.includes('parity'), 'Data Quality drilldown must stay focused on freshness/schema/parity')
assert(!dataQuality.includes('deployGateApi') && !dataQuality.includes('Deploy Gate'), 'Data Quality drilldown must not duplicate Deploy Gate')

console.log('obsInformationArchitectureContract: execution chain + standalone registry passed')
