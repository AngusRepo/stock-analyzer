import assert from 'node:assert/strict'
import {
  domainBackfillBatchLimit,
  domainBackfillKeysetWhere,
  domainBackfillParityBatchLimit,
  domainBackfillRollingManifest,
  domainBackfillRowsPerStatement,
  isDomainShadowCopyComplete,
  isDomainShadowCutoverReady,
} from './dataDomainShadowBackfill'
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
assert.equal(domainBackfillParityBatchLimit(500), 2000)
assert.equal(domainBackfillParityBatchLimit(50), 200)
assert.equal(domainBackfillRowsPerStatement(13), 7)
assert.equal(domainBackfillRowsPerStatement(100), 1)
assert.equal(domainBackfillRowsPerStatement(0), 100)
assert.equal(isDataDomainShadowProgressStale(null, null, Date.parse('2026-08-03T12:10:00Z')), false)
assert.equal(isDataDomainShadowProgressStale('2026-08-03T12:06:00Z', null, Date.parse('2026-08-03T12:10:00Z')), false)
assert.equal(isDataDomainShadowProgressStale('2026-08-03T12:00:00Z', '2026-08-03T12:04:59Z', Date.parse('2026-08-03T12:10:00Z')), true)

async function testRollingManifests(): Promise<void> {
  const firstManifest = await domainBackfillRollingManifest(null, 'batch-a', 500)
  const repeatedManifest = await domainBackfillRollingManifest(null, 'batch-a', 500)
  const secondManifest = await domainBackfillRollingManifest(firstManifest, 'batch-b', 250)
  const reorderedManifest = await domainBackfillRollingManifest(
    await domainBackfillRollingManifest(null, 'batch-b', 250), 'batch-a', 500,
  )
  assert.equal(firstManifest, repeatedManifest)
  assert.notEqual(secondManifest, reorderedManifest)
}

void testRollingManifests().then(() => {
  console.log('data domain shadow backfill tests passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
