import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const page = fs.readFileSync(path.join(root, 'src', 'pages', 'MarketHomePage.tsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src', 'index.css'), 'utf8')
const main = fs.readFileSync(path.join(root, 'src', 'main.tsx'), 'utf8')

assert(page.includes('sv-home-glass-panel'), 'Homepage glass panels should use the isolated paint class')
assert((page.match(/sv-home-deferred-section/g) ?? []).length >= 2, 'Below-fold homepage groups should defer rendering')
assert(page.includes('xl:grid-cols-[minmax(0,3fr)_minmax(380px,2fr)]'), 'Recommendation list and group residual momentum must share a 6:4 desktop row')
assert(page.includes('aria-label="市場概況與風險"'), 'Market overview should be split into a semantic section')
assert(page.includes("panelClass('grid gap-4 p-4 xl:self-stretch')"), 'Large market overview should be split into contained cards')

assert(css.includes('.sv-home-glass-panel'), 'Homepage glass panel CSS should exist')
assert(css.includes('box-shadow: none !important;'), 'Homepage glass panels should not paint large shadows')
assert(css.includes('contain: layout paint;'), 'Homepage glass panels should isolate layout and paint')
assert(css.includes('content-visibility: auto;'), 'Below-fold homepage groups should skip offscreen rendering')
assert(css.includes('contain-intrinsic-size: auto 760px;'), 'Deferred homepage groups should reserve intrinsic height')
assert(!css.includes('.sv-stockintelli-page [class*="shadow-"],'), 'Global Tailwind shadow overrides should stay removed')
assert(!css.includes('.sv-stockintelli-page [class*="bg-black/"] {'), 'Background utility classes must not receive global heavy shadows')
assert(css.includes('@media (max-width: 767px), (prefers-reduced-motion: reduce)'), 'Mobile and reduced-motion fallback should exist')
assert(css.includes('.sv-app-header {') && css.includes('backdrop-filter: none !important;'), 'Fallback should disable expensive backdrop blur')

assert(!page.includes("'backdrop-blur-xl',"), 'Desktop homepage panels should not use large backdrop blur surfaces')
assert(css.includes('-webkit-backdrop-filter: none !important;') && css.includes('backdrop-filter: none !important;'), 'Homepage panels should explicitly disable backdrop filters')
assert(!page.includes('sv-home-keyword-cloud') && !page.includes('new IntersectionObserver('), 'Removed keyword animation should not return to the homepage')

assert(main.includes("navigator.serviceWorker.addEventListener('controllerchange'"), 'PWA should detect an activated replacement worker')
assert(main.includes('if (serviceWorkerReloadScheduled) return') && main.includes('window.location.reload()'), 'PWA should reload an existing document exactly once when a replacement worker claims it')
assert(!main.includes('sessionStorage.getItem(serviceWorkerReloadKey)'), 'PWA reload suppression must not survive across deployments and strand an old lazy-chunk graph')
assert(main.includes("window.addEventListener('vite:preloadError'") && main.includes('recoverStaleAssetGraph()'), 'stale lazy chunks must self-recover after a deployment')
assert(main.includes("window.addEventListener('unhandledrejection'") && main.includes('Failed to fetch dynamically imported module'), 'dynamic-import failures must self-recover when browsers do not emit vite:preloadError')
assert(main.includes('void updateServiceWorker(false)'), 'PWA refresh should delegate reloading to the guarded controllerchange handler')

console.log('marketHomePerformanceContract: OK')
