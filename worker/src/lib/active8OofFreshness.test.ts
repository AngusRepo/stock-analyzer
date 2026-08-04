import { strict as assert } from 'node:assert'
import { evaluateActive8OofFreshness } from './active8OofFreshness'

const fresh = evaluateActive8OofFreshness({
  expected_max_date: '2026-07-28',
  effective_max_date: '2026-07-28',
  cohort_id: 'cohort-1',
})
assert.equal(fresh.status, 'fresh')
assert.equal(fresh.reason, 'effective_oof_max_reached_immutable_prep')

const ahead = evaluateActive8OofFreshness({
  expected_max_date: '2026-07-28',
  effective_max_date: '2026-07-29',
})
assert.equal(ahead.status, 'fresh')

const stale = evaluateActive8OofFreshness({
  expected_max_date: '2026-07-28',
  effective_max_date: '2026-07-27',
})
assert.equal(stale.status, 'failed')
assert.equal(stale.reason, 'effective_oof_max_behind_immutable_prep')

const missing = evaluateActive8OofFreshness({
  effective_max_date: '2026-07-28',
})
assert.equal(missing.status, 'missing')
assert.equal(missing.reason, 'expected_mature_max_missing')
