import assert from 'node:assert/strict'
import { domainBackfillKeysetWhere } from './dataDomainShadowBackfill'

assert.deepEqual(domainBackfillKeysetWhere(['id'], null), { sql: '', binds: [] })
assert.deepEqual(domainBackfillKeysetWhere(['date', 'symbol'], ['2026-07-23', '2330']), {
  sql: 'WHERE ("date", "symbol") > (?, ?)',
  binds: ['2026-07-23', '2330'],
})
assert.throws(() => domainBackfillKeysetWhere(['id'], [1, 2]), /cursor_shape_mismatch/)
assert.throws(() => domainBackfillKeysetWhere(['bad-name'], [1]), /invalid_sql_identifier/)
