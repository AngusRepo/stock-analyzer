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
  // Projected once per task from the latest snapshot, never per observation row.
  assert.match(source, /strategyEvidenceRegimeProjectionSql\('alpha_context'\)/)
  assert.doesNotMatch(source, /strategyEvidenceRegimeProjectionSql\('[av]\.alpha_context'\)/)
  assert.doesNotMatch(source, /FROM strategy_evidence_observations_v1 v\n\s+WHERE v\.outcome_known_date<=\?/)
  assert.doesNotMatch(source, /\n\s+v\.alpha_context\n/)
  assert.doesNotMatch(source, /SELECT a\.alpha_context FROM allocator_ev_feature_snapshots/)
})
