import assert from 'node:assert/strict'
import { domainBackfillBatchLimit, domainBackfillKeysetWhere, isDomainShadowCopyComplete, isDomainShadowCutoverReady } from './dataDomainShadowBackfill'
import { isDataDomainShadowProgressStale } from './dataDomainShadowBackfillDrain'

assert.deepEqual(domainBackfillKeysetWhere(['id'], null), { sql: '', binds: [] })
assert.deepEqual(domainBackfillKeysetWhere(['date', 'symbol'], ['2026-07-23', '2330']), {
  sql: 'WHERE ("date", "symbol") > (?, ?)',
  binds: ['2026-07-23', '2330'],
})
assert.throws(() => domainBackfillKeysetWhere(['id'], [1, 2]), /cursor_shape_mismatch/)
assert.throws(() => domainBackfillKeysetWhere(['bad-name'], [1]), /invalid_sql_identifier/)

assert.equal(isDomainShadowCopyComplete(['runs', 'items'], ['runs']), false)
assert.equal(isDomainShadowCopyComplete(['runs', 'items'], ['items', 'runs']), true)
assert.equal(isDomainShadowCopyComplete([], []), false)
assert.equal(isDomainShadowCutoverReady(['runs'], ['runs'], []), false)
assert.equal(isDomainShadowCutoverReady(['runs'], ['runs'], ['runs']), true)
assert.equal(domainBackfillBatchLimit(), 500)
assert.equal(domainBackfillBatchLimit(0), 1)
assert.equal(domainBackfillBatchLimit(5000), 500)
assert.equal(isDataDomainShadowProgressStale(null, null, Date.parse('2026-08-03T12:10:00Z')), false)
assert.equal(isDataDomainShadowProgressStale('2026-08-03T12:06:00Z', null, Date.parse('2026-08-03T12:10:00Z')), false)
assert.equal(isDataDomainShadowProgressStale('2026-08-03T12:00:00Z', '2026-08-03T12:04:59Z', Date.parse('2026-08-03T12:10:00Z')), true)

console.log('data domain shadow backfill tests passed')
