const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')

const queryPolicyPath = path.join(frontend, 'lib', 'queryPolicy.ts')
const virtualListPath = path.join(frontend, 'components', 'performance', 'VirtualizedList.tsx')
const mainSource = fs.readFileSync(path.join(frontend, 'main.tsx'), 'utf8')
const appShellSource = fs.readFileSync(path.join(frontend, 'components', 'AppShell.tsx'), 'utf8')
const dailyPanelSource = fs.readFileSync(path.join(frontend, 'components', 'DailyRecommendationPanelV2.tsx'), 'utf8')
const obsSource = fs.readFileSync(path.join(frontend, 'pages', 'ObservabilityPage.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.join(frontend, 'lib', 'api.ts'), 'utf8')
const recommendationRouteSource = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'other.ts'), 'utf8')

assert(fs.existsSync(queryPolicyPath), 'frontend must centralize React Query cache and prefetch policy')
assert(fs.existsSync(virtualListPath), 'frontend must provide a reusable virtualized list for large OBS/funnel tables')

const queryPolicy = fs.existsSync(queryPolicyPath) ? fs.readFileSync(queryPolicyPath, 'utf8') : ''
assert(queryPolicy.includes('refetchOnWindowFocus: false'), 'query policy must stop focus-driven duplicate refetches')
assert(queryPolicy.includes('gcTime'), 'query policy must tune cache retention for page switches')
assert(queryPolicy.includes('prefetchWorkstationRoute'), 'query policy must expose route-level prefetch for heavy workstations')
assert(queryPolicy.includes('recommendationDailyKey'), 'query policy must own daily recommendation cache keys')
assert(queryPolicy.includes('selectRecommendationLanes'), 'query policy must expose server-payload lane selector')

assert(mainSource.includes('defaultQueryOptions'), 'main QueryClient must use centralized default query options')
assert(appShellSource.includes('useQueryClient'), 'AppShell sidebar must prefetch route data before navigation')
assert(appShellSource.includes('prefetchWorkstationRoute'), 'AppShell sidebar must use the centralized route prefetch contract')
assert(apiSource.includes("view?: 'full' | 'card'"), 'recommendation API client must expose card-view payload slimming')
assert(dailyPanelSource.includes('recommendationDailyKey'), 'DailyRecommendationPanelV2 must share the canonical recommendation query key')
assert(dailyPanelSource.includes('selectRecommendationLanes'), 'DailyRecommendationPanelV2 must avoid recomputing payload lanes ad hoc')
assert(dailyPanelSource.includes("view: 'card'"), 'DailyRecommendationPanelV2 must request the compact card payload')
assert(obsSource.includes('VirtualizedList'), 'OBS must virtualize large event/job lists instead of rendering every row')
assert(recommendationRouteSource.includes('compactRecommendationForCard'), 'Worker daily recommendations must support compact card payloads')
assert(recommendationRouteSource.includes("c.req.query('view') === 'card'"), 'Worker must make payload slimming an explicit request contract')
