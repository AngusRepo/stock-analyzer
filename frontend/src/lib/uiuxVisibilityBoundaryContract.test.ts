import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function read(root: string, ...parts: string[]) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

function extractRootPrefetchBlock(source: string): string {
  const marker = "if (href === '/')"
  const start = source.indexOf(marker)
  assert(start >= 0, 'queryPolicy should have a dedicated public Home prefetch branch')
  const end = source.indexOf('\n  }\n', start)
  assert(end > start, 'queryPolicy public Home prefetch branch should be parseable')
  return source.slice(start, end)
}

const root = process.cwd()
const appPath = path.join(root, 'src', 'App.tsx')
const homePath = path.join(root, 'src', 'pages', 'DailyFocusHomePage.tsx')
const prototypePath = path.join(root, 'src', 'pages', 'DailyFocusPrototypePage.tsx')
const inspectorPath = path.join(root, 'src', 'pages', 'ModelPoolInspectorPage.tsx')
const boundaryPath = path.join(root, 'src', 'lib', 'dailyFocusVisibility.ts')
const queryPolicyPath = path.join(root, 'src', 'lib', 'queryPolicy.ts')
const botPath = path.join(root, 'src', 'pages', 'BotDashboard.tsx')
const themePanelPath = path.join(root, 'src', 'components', 'DailyRecommendationPanel.tsx')
const detailedDailyPanelPath = path.join(root, 'src', 'components', 'DailyRecommendationPanelV2.tsx')
const dashboardPath = path.join(root, 'src', 'pages', 'Dashboard.tsx')

assert(fs.existsSync(homePath), 'DailyFocusHomePage should exist as the formal Home route')
assert(!fs.existsSync(prototypePath), 'Retired DailyFocusPrototypePage should not remain as a duplicate Home surface')
assert(fs.existsSync(inspectorPath), 'ModelPool raw inspector should exist as its own page')
assert(fs.existsSync(boundaryPath), 'Daily focus visibility boundary helper should exist')

const app = read(root, 'src', 'App.tsx')
const home = read(root, 'src', 'pages', 'DailyFocusHomePage.tsx')
const inspector = read(root, 'src', 'pages', 'ModelPoolInspectorPage.tsx')
const boundary = read(root, 'src', 'lib', 'dailyFocusVisibility.ts')
const queryPolicy = read(root, 'src', 'lib', 'queryPolicy.ts')
const bot = read(root, 'src', 'pages', 'BotDashboard.tsx')
const themePanel = read(root, 'src', 'components', 'DailyRecommendationPanel.tsx')
const dashboard = read(root, 'src', 'pages', 'Dashboard.tsx')

assert(app.includes("const DailyFocusHomePage = lazy(() => import('./pages/DailyFocusHomePage'))"), 'App should lazy-load the formal Home page')
assert(app.includes('<Route path="/" component={DailyFocusHomePage} />'), 'Root route should render DailyFocusHomePage')
assert(app.includes('<Route path="/dashboard" component={Dashboard} />'), 'Legacy Dashboard should remain available at /dashboard')
assert(!app.includes('DailyFocusPrototypePage'), 'Preview daily-focus prototype should not remain as a routable duplicate surface')
assert(app.includes('path="/preview/daily-focus"') && app.includes('<Redirect to="/" replace />'), 'Old /preview/daily-focus URL should redirect to formal Home')
assert(app.indexOf('path="/model-pool/inspector"') >= 0, 'App should expose /model-pool/inspector')
assert(app.indexOf('path="/model-pool/inspector"') < app.indexOf('path="/model-pool"'), 'Inspector route should be declared before /model-pool')

assert(!home.includes('recommendationsApi.daily('), 'Public Home must not call recommendationsApi.daily')
assert(!home.includes('paperApi.pendingBuys'), 'Public Home must not call paperApi.pendingBuys')
assert(!home.includes('RecommendationCardClean'), 'Public Home must not render detailed recommendation cards')
assert(!home.includes('symbol:'), 'Public Home should not construct symbol-level trading rows')
assert(home.includes('buildPublicDailyFocusPacket'), 'Public Home should use the visibility boundary helper')
assert(home.includes("recommendationsApi.sectorFlow(undefined, 'theme')"), 'Public Home should read public theme flow aggregates')
assert(home.includes('recommendationsApi.dailyReport'), 'Public Home should read public daily report context')
assert(home.includes('marketApi.risk'), 'Public Home should read public market risk context')

assert(boundary.includes('PublicDailyFocusPacket'), 'Visibility boundary should name the public packet contract')
assert(boundary.includes('publicCandidateCount'), 'Visibility boundary should expose aggregate candidate count only')
assert(!boundary.includes('target_symbol'), 'Visibility boundary must not encode target symbols')
assert(!boundary.includes('pendingBuys'), 'Visibility boundary must not encode pending buys')

assert(bot.includes('paperApi.pendingBuys'), 'Bot should remain the private pending-buy execution surface')
assert(bot.includes('BotExecutionCandidateCard'), 'Bot should render private execution candidate cards')
assert(bot.includes('PreDebateStagingPool'), 'Bot may render private pre-debate staging before pending buys exist')
assert(bot.includes('shouldShowPreDebateStaging'), 'Bot should gate candidate staging by lifecycle state')
assert(!bot.includes('FallbackRecommendations'), 'Bot should not use public daily recommendation fallback')

assert(fs.existsSync(themePanelPath), 'Theme flow panels should remain available for Dashboard and Bot context')
assert(!fs.existsSync(detailedDailyPanelPath), 'Retired DailyRecommendationPanelV2 should not remain as a duplicate detailed recommendation surface')
assert(themePanel.includes('export function ThemeFlowPanel'), 'Dashboard should keep the public theme-flow visualization widget')
assert(themePanel.includes('export function BotThemeFlowPanel'), 'Bot should keep the private theme-flow visualization widget')
assert(!themePanel.includes('export function DailyRecommendationPanel'), 'Legacy DailyRecommendationPanel recommendation list should not remain exported')
assert(!themePanel.includes('recommendationsApi.daily()'), 'Legacy theme-flow file must not fetch full daily recommendations')

assert(fs.existsSync(dashboardPath), 'Legacy Dashboard should remain available as a stock drilldown workspace')
assert(dashboard.includes('DailyFocusRoutingPanel'), 'Dashboard empty state should route users to Home/Bot instead of duplicating daily recommendations')
assert(dashboard.includes('ThemeFlowPanel'), 'Dashboard may keep aggregate theme-flow visualization')
assert(!dashboard.includes('DailyRecommendationPanelV2'), 'Dashboard should not render the detailed daily recommendation panel')
assert(!dashboard.includes('RecommendationCardClean'), 'Dashboard empty state should not render detailed recommendation cards')

assert(inspector.includes('modelPoolApi.artifactRegistry'), 'ModelPool inspector should load raw artifact registry data')
assert(inspector.includes('artifactRegistry'), 'ModelPool inspector should use the artifact registry query key')
assert(inspector.includes('Raw Artifact Inspector'), 'ModelPool inspector should label itself as a raw inspector')

const homePrefetch = extractRootPrefetchBlock(queryPolicy)
assert(homePrefetch.includes('marketApi.risk'), 'Home prefetch should include public market risk')
assert(homePrefetch.includes('recommendationsApi.sectorFlow'), 'Home prefetch should include public sector flow')
assert(homePrefetch.includes('recommendationsApi.dailyReport'), 'Home prefetch should include public daily report')
assert(!homePrefetch.includes('recommendationDailyKey'), 'Home prefetch must not use recommendationDailyKey')
assert(!homePrefetch.includes('recommendationsApi.daily('), 'Home prefetch must not fetch detailed daily recommendations')
