import assert from 'node:assert/strict'
import {
  evaluateDataDomainBackfillRetirement,
  isFrozenExactCutoverReceipt,
} from './dataDomainBackfillRetirementReadiness'
import { tablesForDataDomainShadowBackfill } from './dataDomainRegistry'

const owned = ['pipeline_runs', 'cost_events']
const cursorRows = owned.map((table_name) => ({
  table_name,
  status: 'complete',
  last_batch_rows: 0,
  updated_at: '2026-08-20T00:00:00Z',
}))
const parityRows = owned.map((table_name, index) => ({
  table_name,
  status: 'pass',
  source_count: 10,
  target_count: 10,
  source_checksum: String(index + 1).repeat(64),
  target_checksum: String(index + 1).repeat(64),
  // An old receipt remains valid after cutover: the target is now expected to
  // receive new writes while the legacy source stays frozen.
  checked_at: '2026-08-20T00:00:00Z',
}))
const cutover = {
  status: 'complete',
  source_row_count: 20,
  target_row_count: 20,
  source_checksum: 'a'.repeat(64),
  target_checksum: 'a'.repeat(64),
  parity_checked_at: '2026-08-20T00:00:00Z',
}
const writerEpoch = { epoch: 7, writer_state: 'cutover' }

assert.equal(isFrozenExactCutoverReceipt(cutover), true)
assert.equal(isFrozenExactCutoverReceipt({
  ...cutover,
  target_row_count: 21,
}), false)
assert.equal(isFrozenExactCutoverReceipt({
  ...cutover,
  target_checksum: '',
}), false)

const ready = evaluateDataDomainBackfillRetirement({
  domain: 'ops',
  ownedTables: owned,
  cursorRows,
  parityRows,
  pendingProjectionEvents: 0,
  projectionErrorEvents: 0,
  cutover,
  writerEpoch,
  activeBackfillRunId: null,
})
assert.equal(ready.eligible, true)
assert.deepEqual(ready.blockers, [])
assert.equal(ready.completed_tables, owned.length)
assert.equal(ready.zero_last_batch_tables, owned.length)
assert.equal(ready.historical_parity_tables, owned.length)

const nonZeroLastBatch = evaluateDataDomainBackfillRetirement({
  domain: 'ops',
  ownedTables: owned,
  cursorRows: cursorRows.map((row, index) => index === 0 ? { ...row, last_batch_rows: 1 } : row),
  parityRows,
  pendingProjectionEvents: 0,
  projectionErrorEvents: 0,
  cutover,
  writerEpoch,
  activeBackfillRunId: null,
})
assert.equal(nonZeroLastBatch.eligible, false)
assert(nonZeroLastBatch.blockers.includes('cursor_last_batch_not_zero'))
assert.deepEqual(nonZeroLastBatch.last_batch_not_zero_tables, [owned[0]])

const activeSession = evaluateDataDomainBackfillRetirement({
  domain: 'ops',
  ownedTables: owned,
  cursorRows,
  parityRows,
  pendingProjectionEvents: 0,
  projectionErrorEvents: 0,
  cutover,
  writerEpoch,
  activeBackfillRunId: 'backfill-run-1',
})
assert.equal(activeSession.eligible, false)
assert(activeSession.blockers.includes('active_backfill_session'))

const incompleteEvidence = evaluateDataDomainBackfillRetirement({
  domain: 'ops',
  ownedTables: owned,
  cursorRows: cursorRows.slice(1),
  parityRows: parityRows.slice(1),
  pendingProjectionEvents: 1,
  projectionErrorEvents: 1,
  cutover: { ...cutover, status: 'write_cutover' },
  writerEpoch: { ...writerEpoch, writer_state: 'open' },
  activeBackfillRunId: null,
})
assert.equal(incompleteEvidence.eligible, false)
for (const blocker of [
  'cutover_not_complete',
  'writer_not_cutover',
  'projection_pending_nonzero',
  'projection_errors_present',
  'cursor_incomplete',
  'cursor_last_batch_not_zero',
  'historical_full_table_parity_not_exact',
]) assert(incompleteEvidence.blockers.includes(blocker), `missing blocker ${blocker}`)

const postCutoverLearningTables = [
  'state_space_v2_runs',
  'state_space_v2_observations',
  'state_space_v2_evaluations',
  'pit_factor_shadow_daily_v1',
  'expected_return_candidate_forward_evaluations',
]
const learningBackfillTables = tablesForDataDomainShadowBackfill('learning')
for (const table of postCutoverLearningTables) {
  assert(!learningBackfillTables.includes(table), `${table} must not require a legacy backfill cursor`)
}
assert(
  !tablesForDataDomainShadowBackfill('ops').includes('pit_residual_funnel_enrichment_runs_v1'),
  'post-cutover PIT residual receipts must not require a legacy backfill cursor',
)

console.log('dataDomainBackfillRetirementReadiness tests passed')
