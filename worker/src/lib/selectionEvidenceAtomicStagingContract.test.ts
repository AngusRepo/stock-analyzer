import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/lib/selectionReferenceEvidence.ts', 'utf8')
const migration = fs.readFileSync('domain-migrations/learning/0021_selection_evidence_atomic_staging.sql', 'utf8')
const casMigration = fs.readFileSync('domain-migrations/learning/0022_selection_evidence_ready_cas.sql', 'utf8')
const learningSchema = fs.readFileSync('domain-schemas/learning.sql', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')

for (const table of [
  'selection_evidence_staging_runs_v1',
  'selection_reference_snapshots_staging_v1',
  'strategy_label_matrix_staging_v4',
]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  assert.match(learningSchema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  assert.match(registry, new RegExp(`'${table}'`))
}

assert.match(source, /INSERT INTO selection_reference_snapshots_staging_v1/)
assert.match(source, /INSERT INTO strategy_label_matrix_staging_v4/)
assert.match(source, /selection_evidence_staging_coverage_mismatch/)
assert.match(source, /reference_contract_rows/)
assert.match(source, /matrix_contract_rows/)
assert.match(source, /selection_evidence_writer_fenced/)

const coverageIndex = source.indexOf('selection_evidence_staging_coverage_mismatch')
const firstCanonicalDelete = source.indexOf('DELETE FROM strategy_label_matrix_v4')
assert(coverageIndex >= 0 && firstCanonicalDelete > coverageIndex,
  'canonical rows must not be deleted before staged coverage validation')

const cutoverStart = source.indexOf('const validatedAttempt')
const cutoverEnd = source.indexOf('const cutoverReceipt', cutoverStart)
assert(cutoverStart >= 0 && cutoverEnd > cutoverStart)
const cutover = source.slice(cutoverStart, cutoverEnd)
for (const contract of [
  'await db.batch([',
  'DELETE FROM strategy_label_matrix_v4',
  'DELETE FROM selection_reference_snapshots_v1',
  'INSERT INTO selection_reference_snapshots_v1',
  'FROM selection_reference_snapshots_staging_v1 st',
  'INSERT INTO strategy_label_matrix_v4',
  'FROM strategy_label_matrix_staging_v4 st',
  "status='ready'",
  "status='promoted'",
  'DELETE FROM strategy_label_matrix_staging_v4',
  'DELETE FROM selection_reference_snapshots_staging_v1',
]) assert(cutover.includes(contract), `atomic cutover missing ${contract}`)

assert(!source.slice(0, coverageIndex).includes('DELETE FROM selection_reference_snapshots_v1'),
  'staging or interruption must leave canonical references intact')
assert(!source.slice(0, coverageIndex).includes('DELETE FROM strategy_label_matrix_v4'),
  'staging or interruption must leave canonical matrix intact')

for (const column of [
  'evidence_artifact_id',
  'payload_checksum',
  'promotion_attempt_id',
]) {
  assert.match(casMigration, new RegExp(`ALTER TABLE strategy_label_matrix_runs_v4 ADD COLUMN ${column}`))
  assert.match(learningSchema, new RegExp(`strategy_label_matrix_runs_v4 \\([\\s\\S]*${column}`))
}
assert.match(casMigration, /ALTER TABLE selection_evidence_staging_runs_v1 ADD COLUMN payload_checksum/)
assert.match(learningSchema, /selection_evidence_staging_runs_v1 \([\s\S]*payload_checksum TEXT NOT NULL/)

const acquisitionStart = source.indexOf('const acquisition = await db.prepare')
const acquisitionEnd = source.indexOf('const heartbeatWriter', acquisitionStart)
assert(acquisitionStart >= 0 && acquisitionEnd > acquisitionStart)
const acquisition = source.slice(acquisitionStart, acquisitionEnd)
for (const contract of [
  "ready.status='ready'",
  "selection_evidence_staging_runs_v1.status IN ('failed', 'promoted')",
  "datetime('now', '-30 minutes')",
  'acquisition.meta?.changes',
  'selection_evidence_writer_busy',
]) assert(acquisition.includes(contract), `writer acquisition CAS missing ${contract}`)

for (const contract of [
  's.payload_checksum=?',
  'NOT EXISTS (',
  "ready.status='ready'",
  'evidence_artifact_id, payload_checksum, promotion_attempt_id',
  "WHERE strategy_label_matrix_runs_v4.status <> 'ready'",
  'ready.promotion_attempt_id=?',
]) assert(cutover.includes(contract), `promotion CAS missing ${contract}`)

const readyVerificationStart = source.indexOf('const verifyReadyCanonical')
const readyVerificationEnd = source.indexOf('const attemptId', readyVerificationStart)
const readyVerification = source.slice(readyVerificationStart, readyVerificationEnd)
for (const contract of [
  'existing.evidence_artifact_id',
  'existing.payload_checksum',
  'existing.promotion_attempt_id',
  'expectedReferenceIdentity',
  'expectedStrategies',
  'strategy_label_matrix_immutable_run_conflict',
]) assert(readyVerification.includes(contract), `ready idempotency verification missing ${contract}`)
assert(!readyVerification.includes('UPDATE selection_reference_snapshots_v1'),
  'ready idempotency verification must not mutate canonical references')
console.log('selection evidence atomic staging contract passed')
