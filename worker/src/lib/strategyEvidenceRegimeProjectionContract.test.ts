import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { strategyEvidenceRegimeProjectionSql } from './strategyEvidenceMetrics'

test('strategy evidence observations project only compact recorded regime context', () => {
  const sql = strategyEvidenceRegimeProjectionSql('v.alpha_context')
  assert.match(sql, /market_regime_context/)
  assert.match(sql, /point_in_time/)
  assert.match(sql, /regime_bucket/)
  assert.match(sql, /regime_surface/)
  assert.doesNotMatch(sql, /SELECT v\.alpha_context/)

  const source = fs.readFileSync('src/lib/strategyEvidenceMetrics.ts', 'utf8')
  assert.match(source, /strategyEvidenceRegimeProjectionSql\('v\.alpha_context'\)/)
  assert.match(source, /strategyEvidenceRegimeProjectionSql\('a\.alpha_context'\)/)
  assert.doesNotMatch(source, /\n\s+v\.alpha_context\n/)
  assert.doesNotMatch(source, /SELECT a\.alpha_context FROM allocator_ev_feature_snapshots/)
})
