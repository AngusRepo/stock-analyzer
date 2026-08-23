import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE,
  RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS,
} from './retentionHotWindowDrain'
import { retentionR2PolicyConfig } from './retentionArchiveOnly'

assert.equal(
  RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE,
  'DRAIN_VERIFIED_D1_HOT_WINDOWS_V1',
)
assert(RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS.includes('learning_lineage_v1'))
assert(RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS.includes('canonical_market_hot_v1'))
assert(!RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS.includes('legacy_hot_r2_v1' as never))
assert(!RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS.includes('oof_lineage_cold_archive_v2' as never))
const learningConfig = retentionR2PolicyConfig('learning_lineage_v1')
assert(learningConfig)
const manifestSource = learningConfig.sources.find((source) => source.datasetId === 'dataset_snapshots')
assert(manifestSource)
assert.equal(manifestSource.deleteTable, undefined)

const implementation = readFileSync('src/lib/retentionHotWindowDrain.ts', 'utf8')
const archiveAt = implementation.indexOf('await writeEvidenceArtifact')
const deleteCallAt = implementation.indexOf('const deleted = await deleteVerifiedRows', archiveAt)
assert(archiveAt >= 0)
assert(deleteCallAt > archiveAt)
const deleteFunction = implementation.slice(
  implementation.indexOf('async function deleteVerifiedRows'),
  implementation.indexOf('async function runPolicy'),
)
assert(deleteFunction.indexOf('await assertRowsUnchanged') >= 0)
assert(deleteFunction.indexOf('DELETE FROM') > deleteFunction.indexOf('await assertRowsUnchanged'))
assert.match(implementation, /retentionClass: 'ten_year_cold_archive'/)
assert.match(implementation, /row_checksum/)
assert.match(implementation, /checksum_verified_at/)
assert.match(implementation, /RETURNING/)
assert.match(implementation, /IN \(SELECT value FROM json_each\(\?\)\)/)
assert.doesNotMatch(deleteFunction, /for \(let offset/)
assert.match(implementation, /options\.confirmPhrase !== RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE/)
assert.match(implementation, /limitPerDataset \?\? 100/)
assert(implementation.includes('Math.min(Math.floor(options.limitPerDataset ?? 100), 250)'))

const scheduler = JSON.parse(readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const preflight = scheduler.jobs.find((job: { id: string }) => job.id === 'retention-hot-window-drain')
assert(preflight)
assert.equal(preflight.task, 'retention-hot-window-drain')
assert.doesNotMatch(String(preflight.query), /confirm_drain/)
assert.match(String(preflight.description), /read-only preflight/)

const mainMigration = readFileSync('migrations/0118_learning_bounded_hot_retention.sql', 'utf8')
const opsMigration = readFileSync('domain-migrations/ops/0009_learning_bounded_hot_retention.sql', 'utf8')
for (const migration of [mainMigration, opsMigration]) {
  assert.match(migration, /hot_retention_days=120/)
  assert.match(migration, /cold_retention_days=3650/)
  assert.match(migration, /action='archive_delete'/)
  assert.match(migration, /price_horizon_learning_v1/)
  assert.match(migration, /strategy_multi_horizon_outcomes_v1/)
}

const artifacts = readFileSync('src/lib/artifactLifecycle.ts', 'utf8')
assert.match(artifacts, /ten_year_cold_archive: 10 \* 365/)

console.log('retention hot-window drain contract tests passed')
