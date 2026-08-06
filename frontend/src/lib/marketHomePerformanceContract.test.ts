import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const page = fs.readFileSync(path.join(root, 'src', 'pages', 'MarketHomePage.tsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src', 'index.css'), 'utf8')

assert(page.includes('sv-home-glass-panel'), 'Homepage glass panels should use the isolated paint class')
assert((page.match(/sv-home-deferred-section/g) ?? []).length >= 2, 'Below-fold homepage groups should defer rendering')
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

console.log('marketHomePerformanceContract: OK')