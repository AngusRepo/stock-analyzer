import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(process.cwd(), 'src')
const home = fs.readFileSync(path.join(root, 'pages/MarketHomePage.tsx'), 'utf8')

test('homepage renders observation-lane rows as POTENTIAL_BUY without mutating canonical evidence', () => {
  assert(home.includes("signal: 'POTENTIAL_BUY'"))
  assert(home.includes('home_canonical_signal: recommendationSignalText(row) || null'))
  assert(home.includes("home_display_lane: 'potential_buy'"))
  assert(home.includes('.filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row))'))
  assert(!home.includes('const holdRows'))
})

test('homepage keeps bounded progressive rendering', () => {
  // List + detail panel replaced the 12-row「顯示更多」toggle: the list is capped at 80 light rows,
  // the first 12 render immediately and the rest render when scrolled near (DeferredRender, no button),
  // and only the selected rec renders the heavy detail (K-line charts, chip-context fetch).
  assert(home.includes('const HOME_RECOMMENDATION_LIMIT = 80'))
  assert(home.includes('const HOME_INITIAL_RECOMMENDATION_LIMIT = 12'))
  assert(home.includes('eligibleRows.slice(0, HOME_INITIAL_RECOMMENDATION_LIMIT).map('))
  assert(/<DeferredRender[^>]*>\s*\{eligibleRows\.slice\(HOME_INITIAL_RECOMMENDATION_LIMIT\)/.test(home))
  assert.equal((home.match(/<RecommendationCardDetail\b/g) ?? []).length, 1)
  assert(!home.includes('顯示更多'))
})
