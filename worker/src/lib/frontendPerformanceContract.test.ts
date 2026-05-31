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
const dailyPanelV2Path = path.join(frontend, 'components', 'DailyRecommendationPanelV2.tsx')
const botSource = fs.readFileSync(path.join(frontend, 'pages', 'BotDashboard.tsx'), 'utf8')
const dashboardSource = fs.readFileSync(path.join(frontend, 'pages', 'Dashboard.tsx'), 'utf8')
const obsSource = fs.readFileSync(path.join(frontend, 'pages', 'ObservabilityPage.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.join(frontend, 'lib', 'api.ts'), 'utf8')
const recommendationRouteSource = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'other.ts'), 'utf8')
const viteConfigSource = fs.readFileSync(path.join(root, 'frontend', 'vite.config.ts'), 'utf8')

assert(fs.existsSync(queryPolicyPath), 'frontend must centralize React Query cache and prefetch policy')
assert(fs.existsSync(virtualListPath), 'frontend must provide a reusable virtualized list for large OBS/funnel tables')
assert(!fs.existsSync(dailyPanelV2Path), 'retired DailyRecommendationPanelV2 must not remain as a duplicate detailed recommendation surface')

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
assert(botSource.includes('PreDebateStagingPool'), 'Bot must own the private pre-debate staging surface')
assert(botSource.includes('shouldShowPreDebateStaging'), 'Bot must gate candidate staging by execution lifecycle state')
assert(botSource.includes('recommendationDailyKey'), 'Bot private staging must share the canonical recommendation query key')
assert(botSource.includes('selectRecommendationLanes'), 'Bot private staging must avoid recomputing payload lanes ad hoc')
assert(botSource.includes("view: 'card'"), 'Bot private staging must request the compact card payload')
assert(botSource.includes('staleTime: queryTtl.intraday'), 'Bot private staging must refresh quickly after historical reruns publish newer rows')
assert(botSource.includes("refetchOnMount: 'always'"), 'Bot private staging must not keep an old payload across route returns')
assert(dashboardSource.includes('DailyFocusRoutingPanel'), 'Dashboard should route users to Home/Bot instead of duplicating daily recommendations')
assert(!dashboardSource.includes('DailyRecommendationPanelV2'), 'Dashboard must not render the retired detailed recommendation panel')
assert(!dashboardSource.includes('RecommendationCardClean'), 'Dashboard must not render detailed recommendation cards in its empty state')
assert(queryPolicy.includes("href === '/bot'") && queryPolicy.includes("recommendationDailyKey(date), queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }), staleTime: queryTtl.intraday"), 'Bot route prefetch must warm compact private staging without a long-lived fallback payload')
assert(!obsSource.includes('VirtualizedList'), 'OBS overview must avoid nested virtual scroll for small incident/job lists')
assert(!obsSource.includes('scrollIntoView({ behavior'), 'OBS incident open must not trigger smooth-scroll jank on every click')
assert(recommendationRouteSource.includes('compactRecommendationForCard'), 'Worker daily recommendations must support compact card payloads')
assert(recommendationRouteSource.includes("c.req.query('view') === 'card'"), 'Worker must make payload slimming an explicit request contract')
assert(viteConfigSource.includes('resolveBuildId'), 'Vite config must derive a build id for production cache busting')
assert(viteConfigSource.includes('entryFileNames') && viteConfigSource.includes('chunkFileNames'), 'Vite output filenames must include build id to prevent stale PWA chunks')
assert(viteConfigSource.includes('VITE_BUILD_ID'), 'Frontend must expose build id for deployment diagnostics')
