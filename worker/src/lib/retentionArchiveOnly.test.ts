import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  RETENTION_ARCHIVE_ONLY_POLICY_IDS,
  buildRetentionArchiveOnlyQuery,
  retentionArchiveOnlyPolicyConfig,
} from './retentionArchiveOnly'

assert.equal(RETENTION_ARCHIVE_ONLY_POLICY_IDS.length, 9)
assert.equal(new Set(RETENTION_ARCHIVE_ONLY_POLICY_IDS).size, 9)

const learning = retentionArchiveOnlyPolicyConfig('learning_lineage_v1')
assert.equal(learning.store, 'r2')
if (learning.store !== 'r2') throw new Error('learning_lineage_v1 must use r2')
assert(learning.sources.some((source) => source.datasetId === 'predictions'))
assert(learning.sources.some((source) => source.datasetId === 'selection_reference_snapshots_v1'))
assert(learning.sources.some((source) => source.datasetId === 'strategy_label_matrix_v4'))

const oof = retentionArchiveOnlyPolicyConfig('oof_lineage_cold_archive_v2')
assert.equal(oof.store, 'gcs')
if (oof.store !== 'gcs') throw new Error('oof_lineage_cold_archive_v2 must use gcs')
assert.deepEqual(oof.sources.map((source) => source.datasetId), [
  'active8_oof_predictions',
  'allocator_ev_oof_snapshots',
  'l4_oof_predictions',
])

const market = retentionArchiveOnlyPolicyConfig('canonical_market_hot_v1')
if (market.store !== 'r2') throw new Error('canonical_market_hot_v1 must use r2')
const source = market.sources[0]
const firstQuery = buildRetentionArchiveOnlyQuery(source, null)
assert.match(firstQuery, /__archive_date < \?/)
assert.match(firstQuery, /ORDER BY __archive_date ASC, __cursor_key ASC/)
assert.doesNotMatch(firstQuery, /DELETE\s+FROM/i)

const cursorQuery = buildRetentionArchiveOnlyQuery(source, {
  cursor_date: '2024-01-01',
  cursor_key: '123',
})
assert.match(cursorQuery, /__archive_date > \? OR \(__archive_date = \? AND __cursor_key > \?\)/)

const implementation = fs.readFileSync('src/lib/retentionArchiveOnly.ts', 'utf8')
assert.doesNotMatch(implementation, /\bDELETE\s+FROM\b/i)
assert.match(implementation, /deletedRows: 0/)
assert.match(implementation, /checksum_verified_at/)
assert.match(implementation, /gcs_archive_payload_approval_required/)

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const scheduled = manifest.jobs.find((job: any) => job.id === 'retention-archive-only')
assert(scheduled)
assert.equal(scheduled.task, 'retention-archive-only')
assert.match(String(scheduled.description), /deleted_rows is always zero/)

console.log('retention archive-only tests passed')
