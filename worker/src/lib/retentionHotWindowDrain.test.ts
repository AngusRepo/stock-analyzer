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
import { runRetentionHotWindowDrain, summarizeRetentionHotWindowDrain } from './retentionHotWindowDrain'
import { classifySchedulerSummary } from './schedulerRunLogger'
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
  // M1-d: ten archive-only sources are blocked datasets, not a policy failure.
  assert.equal(result.status, 'dry_run')
  assert.deepEqual(result.failed_policies, [])
  assert.equal(result.policies[0].status, 'dry_run')
  assert.equal(result.policies[0].error, undefined)
  assert.equal(result.policy_attempts, 1)
  assert.equal(result.deleted_rows, 0)
  assert.equal(result.backlog_remaining, true)
  assert.deepEqual(result.pending_policies, ['learning_lineage_v1'])
  assert.equal(result.policies[0].datasets.length, learningConfig!.sources.length)
  assert.equal(result.policies[0].datasets.filter(d => d.status === 'blocked').length, 10)
  const archiveOnly = learningConfig!.sources.filter(source => !source.deleteTable || !source.deleteKeyColumn).map(source => source.datasetId)
  assert.equal(archiveOnly.length, 10)
  assert.deepEqual(result.policies[0].blocked_datasets, archiveOnly)
  assert.deepEqual(result.blocked_datasets, archiveOnly.map(dataset => `learning_lineage_v1:${dataset}`))
  assert.match(summarizeRetentionHotWindowDrain(result), /status=dry_run .* failed=none blocked=10$/)
  assert.equal(classifySchedulerSummary(summarizeRetentionHotWindowDrain(result)), 'success')
})

// A permissive D1 stand-in: the Learning policy row, predictions columns, and no eligible rows.
function confirmedFixture(failPredictions = false) {
  const writes: Array<{ sql: string; args: unknown[] }> = []
  const db = { prepare(sql: string) {
    let args: unknown[] = []
    const statement = {
      bind(...values: unknown[]) { args = values; return statement },
      async first() {
        if (sql.includes('FROM data_retention_policies')) return { policy_id: 'learning_lineage_v1',
          hot_retention_days: 120, cold_retention_days: 3650, archive_store: 'r2', action: 'archive_delete',
          hard_reference_protected: 1, status: 'active' }
        return null
      },
      async all() {
        if (sql.includes('pragma_table_info')) return { results: [{ name: 'date' }, { name: 'symbol' }] }
        if (failPredictions && sql.includes('WITH candidates AS MATERIALIZED')) throw new Error('predictions_reader_failed')
        return { results: [] }
      },
      async run() { writes.push({ sql, args }); return { success: true, meta: { changes: 1 } } },
    }
    return statement
  }, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())) } }
  const env = { DB: db, ARTIFACTS: {} } as unknown as Bindings
  return { env, writes }
}

test('M1-d: a confirmed Learning drain succeeds on its deletable sources while blocked sources stay pending', async () => {
  const { env, writes } = confirmedFixture()
  const result = await runRetentionHotWindowDrain(env, { policyIds: ['learning_lineage_v1'],
    businessDate: '2026-10-29', maxRounds: 10, confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE })
  assert.equal(result.dry_run, false)
  assert.equal(result.status, 'success')
  assert.equal(result.policies[0].status, 'success')
  assert.deepEqual(result.failed_policies, [])
  assert.equal(result.complete, false)
  assert.equal(result.stop_reason, 'blocked_or_no_progress')
  assert.equal(result.blocked_datasets.length, 10)
  const drained = result.policies[0].datasets.filter(d => d.status !== 'blocked')
  assert.ok(drained.length >= 1 && drained.every(d => d.status === 'skipped'))
  // Ledger: blocked items are skipped with backlog, and the run itself finishes as success.
  const blockedItems = writes.filter(w => /data_retention_run_items/.test(w.sql)
    && String(w.args[1]).startsWith('hot-drain:') && /cold_reader_not_verified/.test(JSON.stringify(w.args)))
  assert.equal(blockedItems.length, 10)
  assert.ok(blockedItems.every(w => w.args[2] === 'skipped'))
  const finished = writes.filter(w => /UPDATE data_retention_runs/.test(w.sql))
  assert.equal(finished.length, 1)
  assert.ok(finished[0].args.includes('success'))
  assert.match(summarizeRetentionHotWindowDrain(result), /status=success .* failed=none blocked=10$/)
})

test('M1-d: a failing deletable source still fails the policy and the route', async () => {
  const { env } = confirmedFixture(true)
  const result = await runRetentionHotWindowDrain(env, { policyIds: ['learning_lineage_v1'],
    businessDate: '2026-10-29', maxRounds: 10, confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE })
  assert.equal(result.status, 'error')
  assert.deepEqual(result.failed_policies, ['learning_lineage_v1'])
  assert.match(String(result.policies[0].error), /predictions_reader_failed/)
  assert.doesNotMatch(String(result.policies[0].error), /cold_reader_not_verified/)
  assert.equal(result.blocked_datasets.length, 10)
})
