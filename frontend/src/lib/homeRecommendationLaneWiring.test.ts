import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(process.cwd(), 'src')
const home = fs.readFileSync(path.join(root, 'pages/MarketHomePage.tsx'), 'utf8')
const card = fs.readFileSync(path.join(root, 'components/RecommendationCardClean.tsx'), 'utf8')

test('homepage renders observation-lane rows as POTENTIAL_BUY without mutating canonical evidence', () => {
  assert(home.includes("signal: 'POTENTIAL_BUY'"))
  assert(home.includes('home_canonical_signal: recommendationSignalText(row) || null'))
  assert(home.includes("home_display_lane: 'potential_buy'"))
  assert(home.includes("home_potential_buy_kind: isObservationalPotentialBuyRecommendation(row)"))
  assert(home.includes("'upstream_observation_non_executable'"))
  assert(home.includes('上游觀察 {observationalPotentialBuyCount}'))
  assert(card.includes('上游觀察 · 不可執行'))
  assert(home.includes('.filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row))'))
  assert(!home.includes('const holdRows'))
})

test('homepage keeps bounded progressive rendering', () => {
  assert(home.includes('const HOME_INITIAL_RECOMMENDATION_LIMIT = 12'))
})
