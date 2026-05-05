const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')
const appShell = fs.readFileSync(path.join(frontend, 'components', 'AppShell.tsx'), 'utf8')
const obs = fs.readFileSync(path.join(frontend, 'pages', 'ObservabilityPage.tsx'), 'utf8')
const scheduler = fs.readFileSync(path.join(frontend, 'pages', 'SchedulerPage.tsx'), 'utf8')
const dataQuality = fs.readFileSync(path.join(frontend, 'pages', 'DataQualityPage.tsx'), 'utf8')

assert(appShell.includes("href: '/obs'"), 'OBS must remain the main observability entry in sidebar')
assert(appShell.includes("href: '/model-pool'"), 'Model Pool must remain a specialist lifecycle explorer in sidebar')
assert(!appShell.includes("href: '/scheduler'"), 'Scheduler must be removed from primary sidebar and become an OBS drilldown')
assert(!appShell.includes("href: '/data-quality'"), 'Data Quality must be removed from primary sidebar and become an OBS drilldown')

assert(obs.includes('Incident Inbox'), 'OBS must prioritize an incident inbox instead of four duplicated summary pages')
assert(obs.includes('Selected Incident Detail'), 'OBS must expose a selected incident detail pane')
assert(obs.includes('Dependency Map'), 'OBS must expose a dependency map for ownership and blast radius')
assert(obs.includes('Health Map / 系統健康地圖'), 'OBS must include a visual health map, not only metric boxes')
assert(obs.includes('查看 / Open'), 'Incident inbox open action must have explicit visible feedback')
assert(obs.includes("setActiveTab('incidents')"), 'Opening an incident must switch/focus the incident detail context')
assert(obs.includes('aria-pressed'), 'Incident selection must expose selected state for accessibility')
assert(obs.includes('Scheduler Runs'), 'OBS must include Scheduler as a compact drilldown tab')
assert(obs.includes('Data Quality'), 'OBS must include Data Quality as a compact drilldown tab')
assert(obs.includes('Model Health Snapshot'), 'OBS must include only a compact model snapshot, not duplicate Model Pool')
assert(obs.includes('Cost / Resource'), 'OBS must include resource/cost as a compact drilldown tab')
assert(obs.includes('No active incidents'), 'OBS empty state must be useful when data is sparse')
assert(obs.includes('資料品質 / Data Quality'), 'OBS labels should be bilingual for readability')
assert(obs.includes('/scheduler') && obs.includes('/data-quality') && obs.includes('/model-pool'), 'OBS must keep deep links to specialist routes')

assert(scheduler.includes('Scheduler Drilldown'), 'Scheduler deep link page should be clearly positioned as drilldown')
assert(!scheduler.includes('dataQualityApi'), 'Scheduler drilldown must not duplicate Data Quality API ownership')
assert(!scheduler.includes('deployGateApi'), 'Scheduler drilldown must not duplicate Deploy Gate ownership')
assert(!scheduler.includes('costsApi'), 'Scheduler drilldown must not duplicate OBS resource/cost ownership')
assert(!scheduler.includes('Data Quality Snapshot'), 'Scheduler drilldown must not render Data Quality snapshot panels')
assert(!scheduler.includes('Cost Tracking'), 'Scheduler drilldown must not render cost panels')
assert(dataQuality.includes('Data Quality Drilldown'), 'Data Quality deep link page should be clearly positioned as drilldown')
assert(dataQuality.includes('freshness') && dataQuality.includes('schema') && dataQuality.includes('parity'), 'Data Quality drilldown should focus on freshness/schema/parity')
assert(!dataQuality.includes('deployGateApi'), 'Data Quality drilldown must not duplicate Deploy Gate ownership')
assert(!dataQuality.includes('Deploy Gate'), 'Data Quality drilldown must not render Deploy Gate summary panels')
