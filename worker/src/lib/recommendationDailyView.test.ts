import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDailyRecommendationView } from '../routes/other'

test('/recommendations/daily serves full only when view=full is named; the default is card', () => {
  assert.equal(resolveDailyRecommendationView(undefined), 'card')
  assert.equal(resolveDailyRecommendationView(''), 'card')
  assert.equal(resolveDailyRecommendationView('card'), 'card')
  assert.equal(resolveDailyRecommendationView('FULL'), 'card')
  assert.equal(resolveDailyRecommendationView('bogus'), 'card')
  assert.equal(resolveDailyRecommendationView('full'), 'full')
  assert.equal(resolveDailyRecommendationView('pipeline'), 'pipeline')
})
