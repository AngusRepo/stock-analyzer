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
const scheduler = fs.readFileSync(path.join(frontend, 'pages', 'SchedulerPage.tsx'), 'utf8')
const dataQuality = fs.readFileSync(path.join(frontend, 'pages', 'DataQualityPage.tsx'), 'utf8')

assert(appShell.includes("href: '/obs'"), 'OBS must remain the main observability entry in sidebar')
assert(appShell.includes("href: '/model-pool'"), 'Model Pool must remain a specialist lifecycle explorer in sidebar')
assert(!appShell.includes("href: '/scheduler'"), 'Scheduler must be removed from primary sidebar and become an OBS drilldown')
assert(!appShell.includes("href: '/data-quality'"), 'Data Quality must be removed from primary sidebar and become an OBS drilldown')

assert(!obs.includes('Incident Inbox'), 'OBS must not render the old incident inbox; root cause belongs on scheduler rows')
assert(!obs.includes('Selected Incident Detail'), 'OBS must not render the old selected incident detail pane')
assert(obs.includes('Dependency Map'), 'OBS must expose a dependency map for ownership and blast radius')
assert(obs.includes('Reliability Map / 可靠度地圖'), 'OBS must include a visual reliability map, not only metric boxes')
assert(obs.includes('computeDataQualityScore'), 'OBS Data Quality percentage must be computed from checks, not hardcoded fail=35')
assert(obs.includes('Scheduler row 直接顯示 root cause'), 'OBS must explain root cause moved into scheduler rows')
assert(obs.includes('發生 {job.lastRun') || obs.includes('發生 '), 'Scheduler rows must expose occurrence time')
assert(obs.includes('Root cause：') && obs.includes('可能影響：'), 'Scheduler rows must expose root cause and impact')
assert(!obs.includes('setActiveTab'), 'OBS must not expose fake tabs when Scheduler and Data Quality are both visible')
assert(obs.includes('SchedulerExecutionMap'), 'OBS must show chain progress instead of an incident selector')
assert(obs.includes('Scheduler Runs'), 'OBS must include Scheduler as a compact drilldown panel')
assert(obs.includes('Data Quality'), 'OBS must include Data Quality as a compact drilldown panel')
assert(!obs.includes('Model Health Snapshot'), 'OBS must not duplicate Model Pool health when the dedicated page owns it')
assert(!obs.includes('Cost / Resource'), 'OBS must not render low-signal resource blocks without actionable data')
assert(obs.includes('目前沒有 scheduler payload'), 'OBS scheduler empty state must be useful when data is sparse')
assert(obs.includes('Data Quality / 資料品質'), 'OBS labels should be bilingual for readability')
assert(obs.includes('/scheduler') && obs.includes('/data-quality'), 'OBS must keep deep links to specialist routes')

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
