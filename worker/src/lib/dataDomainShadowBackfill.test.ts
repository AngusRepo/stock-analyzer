import assert from 'node:assert/strict'
import {
  buildDataDomainAggregateParitySnapshot,
  domainBackfillBatchLimit,
  domainBackfillExactKeyRowsPerStatement,
  domainBackfillExactKeyWhere,
  domainBackfillFinalCountFenceBlockers,
  domainBackfillKeysetWhere,
  domainBackfillParityBatchLimit,
  domainBackfillResumeParityBatchLimit,
  domainBackfillRollingManifest,
  domainBackfillStatementsPerBatch,
  domainBackfillRowsPerStatement,
  isDomainTableSchemaCompatible,
  isDomainShadowCopyComplete,
  isDomainShadowCutoverReady,
  parseDomainBackfillCursor,
} from './dataDomainShadowBackfill'
import {
  dataDomainParityCarryForwardBlockers,
  isDataDomainShadowProgressStale,
} from './dataDomainShadowBackfillDrain'
import { dataDomainManifestPageLimit } from './dataDomainShadowManifest'

assert.deepEqual(domainBackfillKeysetWhere(['id'], null), { sql: '', binds: [] })
assert.deepEqual(domainBackfillKeysetWhere(['date', 'symbol'], ['2026-07-23', '2330']), {
  sql: 'WHERE ("date", "symbol") > (?, ?)',
  binds: ['2026-07-23', '2330'],
})
assert.throws(() => domainBackfillKeysetWhere(['id'], [1, 2]), /cursor_shape_mismatch/)
assert.throws(() => domainBackfillKeysetWhere(['bad-name'], [1]), /invalid_sql_identifier/)
assert.deepEqual(domainBackfillExactKeyWhere(['id'], [{ id: 2 }, { id: 4 }]), {
  sql: 'WHERE ("id" IS ?) OR ("id" IS ?)',
  binds: [2, 4],
})
assert.deepEqual(
  domainBackfillExactKeyWhere(
    ['date', 'symbol'],
    [{ date: '2026-08-15', symbol: '2330' }, { date: '2026-08-15', symbol: '2317' }],
  ),
  {
    sql: 'WHERE ("date" IS ? AND "symbol" IS ?) OR ("date" IS ? AND "symbol" IS ?)',
    binds: ['2026-08-15', '2330', '2026-08-15', '2317'],
  },
)
assert.equal(parseDomainBackfillCursor(undefined), null)
assert.equal(parseDomainBackfillCursor('null'), null)
assert.deepEqual(parseDomainBackfillCursor('["paper","paper_settlements"]'), ['paper', 'paper_settlements'])
assert.throws(() => parseDomainBackfillCursor('{}'), /domain_backfill_cursor_invalid/)
assert.equal(dataDomainManifestPageLimit('screener_funnel_runs', 50), 10)
assert.equal(dataDomainManifestPageLimit('screener_funnel_items', 4000), 4000)
assert.equal(dataDomainManifestPageLimit('allocator_ev_feature_snapshots', 400), 10)

assert.equal(isDomainShadowCopyComplete(['runs', 'items'], ['runs']), false)
assert.equal(isDomainShadowCopyComplete(['runs', 'items'], ['items', 'runs']), true)
assert.equal(isDomainShadowCopyComplete([], []), false)
assert.equal(isDomainShadowCutoverReady(['runs'], ['runs'], []), false)
assert.equal(isDomainShadowCutoverReady(['runs'], ['runs'], ['runs']), true)
assert.equal(domainBackfillBatchLimit(), 500)
assert.equal(domainBackfillBatchLimit(0), 1)
assert.equal(domainBackfillBatchLimit(5000), 500)
assert.equal(domainBackfillBatchLimit(5000, 'strategy_label_matrix_v4'), 1000)
assert.equal(domainBackfillStatementsPerBatch('strategy_label_matrix_v4'), 100)
assert.equal(domainBackfillStatementsPerBatch('predictions'), 50)
assert.equal(domainBackfillParityBatchLimit(500), 4000)
assert.equal(domainBackfillParityBatchLimit(50), 400)
assert.equal(domainBackfillResumeParityBatchLimit(416000, 4000, 400), 400)
assert.equal(domainBackfillResumeParityBatchLimit(0, 4000, 400), 400)
assert.equal(domainBackfillRowsPerStatement(13), 7)
assert.equal(domainBackfillRowsPerStatement(3), 33)
assert.equal(domainBackfillRowsPerStatement(100), 1)
assert.equal(domainBackfillRowsPerStatement(0), 100)
assert.equal(domainBackfillExactKeyRowsPerStatement(1), 48)
assert.equal(domainBackfillExactKeyRowsPerStatement(2), 48)
assert.equal(domainBackfillExactKeyRowsPerStatement(3), 33)
assert.equal(domainBackfillExactKeyRowsPerStatement(100), 1)
assert.deepEqual(domainBackfillFinalCountFenceBlockers({
  expectedSourceRows: 100,
  expectedTargetRows: 100,
  liveSourceRows: 100,
  liveTargetRows: 101,
}), [
  'live_target_count_drift:100/101',
  'live_count_mismatch:100/101',
])
assert.deepEqual(domainBackfillFinalCountFenceBlockers({
  expectedSourceRows: 100,
  expectedTargetRows: 100,
  liveSourceRows: 100,
  liveTargetRows: 100,
}), [])
assert.equal(isDataDomainShadowProgressStale(null, null, Date.parse('2026-08-03T12:10:00Z')), false)
assert.equal(isDataDomainShadowProgressStale('2026-08-03T12:06:00Z', null, Date.parse('2026-08-03T12:10:00Z')), false)
assert.equal(isDataDomainShadowProgressStale('2026-08-03T12:00:00Z', '2026-08-03T12:04:59Z', Date.parse('2026-08-03T12:10:00Z')), true)
assert.deepEqual(dataDomainParityCarryForwardBlockers({
  authoritative: true,
  receiptCheckedAt: '2026-08-16T05:01:32Z',
  tableEpochUpdatedAt: '2026-08-16T04:23:42Z',
  epochBefore: 0,
  epochAfter: 0,
  sourceCount: 465096,
  targetCount: 465096,
  receiptSourceCount: 465096,
  receiptTargetCount: 465096,
}), [])
assert(dataDomainParityCarryForwardBlockers({
  authoritative: true,
  receiptCheckedAt: '2026-08-16T05:01:32Z',
  tableEpochUpdatedAt: '2026-08-16T05:02:00Z',
  epochBefore: 1,
  epochAfter: 1,
  sourceCount: 465096,
  targetCount: 465096,
  receiptSourceCount: 465096,
  receiptTargetCount: 465096,
}).includes('source_write_after_receipt'))
assert(dataDomainParityCarryForwardBlockers({
  authoritative: true,
  receiptCheckedAt: '2026-08-16T05:01:32Z',
  tableEpochUpdatedAt: '2026-08-16T04:23:42Z',
  epochBefore: 0,
  epochAfter: 1,
  sourceCount: 465097,
  targetCount: 465096,
  receiptSourceCount: 465096,
  receiptTargetCount: 465096,
}).includes('table_writer_epoch_changed'))
const schemaA = [
  { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { cid: 1, name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
]
const schemaReordered = [
  { cid: 0, name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
  { cid: 1, name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
]
assert.equal(isDomainTableSchemaCompatible(schemaA, schemaReordered), true)
assert.equal(isDomainTableSchemaCompatible(schemaA, [
  { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
]), false)
assert.equal(isDomainTableSchemaCompatible(schemaA, [
  { cid: 0, name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
  { cid: 1, name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
]), false)


async function testRollingManifests(): Promise<void> {
  const firstManifest = await domainBackfillRollingManifest(null, 'batch-a', 500)
  const repeatedManifest = await domainBackfillRollingManifest(null, 'batch-a', 500)
  const secondManifest = await domainBackfillRollingManifest(firstManifest, 'batch-b', 250)
  const reorderedManifest = await domainBackfillRollingManifest(
    await domainBackfillRollingManifest(null, 'batch-b', 250), 'batch-a', 500,
  )
  assert.equal(firstManifest, repeatedManifest)
  assert.notEqual(secondManifest, reorderedManifest)

  const aggregate = await buildDataDomainAggregateParitySnapshot(
    ['items', 'runs'],
    [
      {
        table_name: 'runs', status: 'pass', source_count: 2, target_count: 2,
        source_checksum: 'a'.repeat(64), target_checksum: 'a'.repeat(64),
      },
      {
        table_name: 'items', status: 'pass', source_count: 3, target_count: 3,
        source_checksum: 'b'.repeat(64), target_checksum: 'b'.repeat(64),
      },
    ],
  )
  assert(aggregate)
  assert.equal(aggregate.source_row_count, 5)
  assert.equal(aggregate.target_row_count, 5)
  assert.equal(aggregate.source_checksum, aggregate.target_checksum)
  assert.equal(await buildDataDomainAggregateParitySnapshot(
    ['runs'],
    [{
      table_name: 'runs', status: 'pass', source_count: 2, target_count: 2,
      source_checksum: 'c'.repeat(64), target_checksum: 'd'.repeat(64),
    }],
  ), null)
}

void testRollingManifests().then(() => {
  console.log('data domain shadow backfill tests passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
