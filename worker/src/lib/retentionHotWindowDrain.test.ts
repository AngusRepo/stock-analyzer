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
assert(deleteFunction.indexOf('releaseArchivedRows') > deleteFunction.indexOf('await assertRowsUnchanged'))
assert.match(implementation, /retentionClass: 'ten_year_cold_archive'/)
assert.match(implementation, /row_checksum/)
assert.match(implementation, /checksum_verified_at/)
const exactSource = readFileSync('src/lib/retentionExactRows.ts', 'utf8')
assert.match(exactSource, /RETURNING/)
assert.match(exactSource, /AS MATERIALIZED/)
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
const opsArtifactSchema = readFileSync('domain-schemas/ops.sql', 'utf8')
const retentionClassMigration = readFileSync(
  'domain-migrations/ops/0010_ten_year_retention_class.sql',
  'utf8',
)
assert.match(opsArtifactSchema, /'ten_year_cold_archive'/)
assert.match(retentionClassMigration, /CREATE TABLE run_artifacts_retention_v2/)
assert.match(retentionClassMigration, /'ten_year_cold_archive'/)

console.log('retention hot-window drain contract tests passed')

// Exercise the real dry-run path: an empty predictions table cannot hide ten unverified readers.
import { test } from 'node:test'
import { runRetentionHotWindowDrain } from './retentionHotWindowDrain'
import type { Bindings } from '../types'
test('dry-run reports every Learning source and never touches unsupported readers', async () => {
  const db = { prepare(sql: string) {
    return { bind(..._args: unknown[]) { return this },
      async first() {
        if (sql.includes('FROM data_retention_policies')) return { policy_id: 'learning_lineage_v1',
          hot_retention_days: 120, cold_retention_days: 3650, archive_store: 'r2', action: 'archive_delete',
          hard_reference_protected: 1, status: 'active' }
        if (sql.includes('FROM predictions')) return null
        throw new Error(`unexpected read: ${sql}`)
      },
      async all() {
        if (sql.includes('pragma_table_info')) return { results: [{ name: 'date' }, { name: 'symbol' }] }
        if (sql.includes('WITH candidates AS MATERIALIZED')) return { results: [] }
        throw new Error(`unexpected read: ${sql}`)
      },
    }
  } }
  const env = { DB: db, ARTIFACTS: {} } as unknown as Bindings
  const result = await runRetentionHotWindowDrain(env, { policyIds: ['learning_lineage_v1'],
    businessDate: '2026-09-26', maxRounds: 10 })
  assert.equal(result.dry_run, true)
  assert.equal(result.complete, false)
  assert.equal(result.status, 'error')
  assert.equal(result.policy_attempts, 1)
  assert.equal(result.deleted_rows, 0)
  assert.equal(result.backlog_remaining, true)
  assert.equal(result.policies[0].datasets.length, learningConfig!.sources.length)
  assert.equal(result.policies[0].datasets.filter(d => d.status === 'blocked').length, 10)
})
