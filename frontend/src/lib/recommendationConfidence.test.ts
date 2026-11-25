import { readFileSync } from 'node:fs'
import {
  agreementText,
  confidenceUnavailableText,
  DEFAULT_CONFIDENCE_SORT,
  percentileText,
  sortByConfidence,
  winRateText,
} from './recommendationConfidence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const available = (symbol: string, ev: number | null, score: number | null, win: number | null, rank: number) => ({
  symbol,
  rank,
  r33_confidence: {
    l4_expected_return: ev,
    r33_score: score,
    signal_date: '2026-11-23',
    percentile: score == null ? { status: 'unavailable', reason: 'r33_score_unavailable' }
      : { status: 'available', value: 96.6, rank: 3, pool_size: 735, models_positive: 3, models_available: 4 },
    win_rate: win == null ? { status: 'unavailable', reason: 'plan_cohort_mismatch' } : { status: 'available', value: win, base_rate: 0.44 },
  },
})

const rows = [
  available('A', -0.0011, 0.2, 0.43, 1),
  available('B', 0.0099, 1.3, 0.54, 4),
  available('C', 0.0099, 1.6, 0.54, 3),
  available('D', null, null, null, 2),
]

assert(DEFAULT_CONFIDENCE_SORT === 'l4_ev', 'default card order is L4 EV')
assert(sortByConfidence(rows, 'l4_ev').map((r) => r.symbol).join() === 'C,B,A,D', 'EV desc, R33 score breaks ties, unavailable last')
assert(sortByConfidence(rows, 'r33_percentile').map((r) => r.symbol).join() === 'C,B,A,D', 'R33 score desc')
assert(sortByConfidence(rows, 'win_rate').map((r) => r.symbol).join() === 'C,B,A,D', 'win rate desc then R33 score')
assert(sortByConfidence(rows, 'legacy_rank').map((r) => r.symbol).join() === 'A,D,C,B', 'legacy rank asc')

assert(percentileText(rows[0].r33_confidence as any) === 'P97', 'percentile renders as P<n>')
assert(agreementText(rows[0].r33_confidence as any) === '3/4 模型看多', 'agreement renders available-model count')
assert(winRateText(rows[1].r33_confidence as any) === '54%', 'win rate renders as percent')
assert(winRateText(rows[3].r33_confidence as any) === '不可用', 'unavailable win rate is explicit')
assert(percentileText(null) === '—' && winRateText(null) === '不可用', 'missing confidence never shows a number')
assert(confidenceUnavailableText('l3_pointer_cohort_mismatch').includes('勝率表需重建'), 'cohort mismatch explains the fail-closed state')

const card = readFileSync('src/components/RecommendationCardClean.tsx', 'utf8')
const body = card.slice(card.indexOf('export function RecommendationCardClean'))
assert(!body.includes('Math.round(scoreViewModel.finalScore)'), 'card header no longer shows the card total score')
assert(!body.includes('<ScoreFormulaSummary'), 'card body no longer renders the total-score formula')
assert(!body.includes('rec.confidence'), 'legacy ensemble_v2 confidence is not displayed')
assert(body.includes('<RecommendationConfidenceStrip confidence={confidence} />'), 'card renders both confidence readings')
const home = readFileSync('src/pages/MarketHomePage.tsx', 'utf8')
assert(home.includes('sortByConfidence(') && !home.includes('recommendationScoreValue'), 'home list sorts by confidence, not card score')
console.log('recommendationConfidence frontend checks passed')
