import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const read = (...segments: string[]) => fs.readFileSync(path.join(root, ...segments), 'utf8')

const app = read('src', 'App.tsx')
const routeModules = read('src', 'lib', 'routeModules.ts')
const main = read('src', 'main.tsx')
const css = read('src', 'index.css')
const viteConfig = read('vite.config.ts')
const headers = read('public', '_headers')
const marketHome = read('src', 'pages', 'MarketHomePage.tsx')
const botDashboard = read('src', 'pages', 'BotDashboard.tsx')
const schedulerPage = read('src', 'pages', 'SchedulerPage.tsx')
const dataQualityPage = read('src', 'pages', 'DataQualityPage.tsx')
const stockReportPage = read('src', 'pages', 'StockReportPage.tsx')
const errorBoundary = read('src', 'components', 'ErrorBoundary.tsx')
const useAuth = read('src', '_core', 'hooks', 'useAuth.ts')

assert(!css.includes('fonts.googleapis.com'), 'Global CSS must not load render-blocking Google Fonts')
assert(!css.includes('fonts.gstatic.com'), 'Global CSS must not load external font binaries')
assert(!css.includes('@import url('), 'Global CSS must not use runtime CSS imports')

assert(!app.includes("from './pages/"), 'App shell must not statically import route pages')
assert((app.match(/lazy\(load[A-Z]/g) ?? []).length >= 12, 'All public and admin routes should be lazy loaded')
assert((routeModules.match(/=> import\('/g) ?? []).length >= 12, 'Route module registry should use dynamic imports')
assert(routeModules.includes('preloadRouteModule'), 'Navigation should support intent-based route preloading')

assert(main.includes("import('virtual:pwa-register')"), 'Service worker registration should be dynamically imported')
assert(main.includes('requestIdleCallback'), 'Service worker registration should wait for browser idle time')
assert(main.includes('immediate: false'), 'Service worker registration must not compete with initial rendering')

assert(!viteConfig.includes("'**/*.{js,css,html,ico,png,svg,woff2}'"), 'Large PNG assets must not be blanket precached')
assert(!viteConfig.includes("'**/*.{js,css,html,ico,svg,woff2}'"), 'All route chunks must not be blanket precached')
assert(viteConfig.includes("'assets/index-*.js'"), 'PWA should precache the JavaScript app shell')
assert(viteConfig.includes("urlPattern: /\\/assets\\/.*\\.(?:js|css)$/"), 'Visited route chunks should use runtime caching')
assert(viteConfig.includes("'**/uiux-demo.html'"), 'Standalone UI demo must stay out of the PWA precache')
assert(viteConfig.includes("'**/obs-chain-demo.html'"), 'Standalone OBS demo must stay out of the PWA precache')
assert(!viteConfig.includes("'vendor-charts': ['recharts', 'lightweight-charts']"), 'Chart libraries must not share one eager vendor chunk')

assert(headers.includes('/assets/*'), 'Hashed assets should have a Cloudflare Pages header rule')
assert(headers.includes('max-age=31536000, immutable'), 'Hashed assets should use long-lived immutable caching')

assert(!marketHome.includes("from 'recharts'"), 'Homepage factor map should not pull Recharts into its route chunk')
assert(marketHome.includes('DeferredRender'), 'Below-fold homepage content should render near the viewport')
assert(marketHome.includes('lazy(loadRecommendationCardClean)'), 'Heavy recommendation cards should load on demand')

assert(botDashboard.includes("lazy(() => import('@/components/CandlestickChart'))"), 'Bot K-line chart should load only after interaction')
assert(botDashboard.includes("lazy(() => import('@/components/charts/PaperTradePerformanceChart'))"), 'Bot performance chart should load near the viewport')
assert((botDashboard.match(/<DeferredRender/g) ?? []).length >= 2, 'Bot below-fold chart and recommendation sections should defer rendering')
assert(schedulerPage.includes("lazy(() => import('@/components/charts/SchedulerCadenceChart'))"), 'Scheduler chart should not block route rendering')
assert(dataQualityPage.includes("lazy(() => import('@/components/charts/DataQualityTrendChart'))"), 'Data Quality chart should not block route rendering')
assert(stockReportPage.includes("lazy(() => import('@/components/charts/DashboardV4LightweightChart'))"), 'Stock report chart should not block route rendering')

assert(!errorBoundary.includes('lucide-react'), 'Initial error boundary should not preload the icon library')
assert(!errorBoundary.includes('@/lib/utils'), 'Initial error boundary should not preload tailwind-merge')
assert(useAuth.includes("from '@/lib/authApi'"), 'Auth shell should load only the auth endpoint module')
assert(!useAuth.includes("from '@/lib/api'"), 'Auth shell must not load the full API endpoint registry')

console.log('sitewidePerformanceContract: OK')
