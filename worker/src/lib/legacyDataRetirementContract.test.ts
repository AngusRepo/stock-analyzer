import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const strategy = readFileSync('src/lib/legacyStrategyEvidenceMigration.ts', 'utf8')
const retirement = readFileSync('src/lib/legacyHotDataRetirement.ts', 'utf8')
const archive = readFileSync('src/lib/auditJsonArchive.ts', 'utf8')
const dashboard = readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')
const predictionsReader = readFileSync('src/lib/retentionPredictionsReader.ts', 'utf8')
const manifest = readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')

assert.match(strategy, /writeEvidenceArtifact/)
assert.match(strategy, /retainArtifactHardReference/)
assert.match(strategy, /strategy_candidate_contexts/)
assert.match(strategy, /context_id=\?, evidence_artifact_id=\?/)
assert.match(strategy, /source_rows_preserved: true/)
assert.match(strategy, /cursor\?\.status === 'complete'/)
assert.match(strategy, /const opsDb = databaseForDataDomain\(env, 'ops'\)/)
assert.match(strategy, /const learningDb = databaseForDataDomain\(env, 'learning'\)/)
assert.doesNotMatch(strategy, /env\.DB\.batch|checkpointLegacyMigration\(env\.DB|retainArtifactHardReference\(env\.DB/)
assert.ok(
  strategy.indexOf("cursor?.status === 'complete'") < strategy.indexOf('WITH candidate_contexts AS'),
  'completed migration must return before scanning strategy_decision_log',
)
assert.ok(
  strategy.indexOf('writeEvidenceArtifact') < strategy.indexOf('UPDATE strategy_decision_log'),
  'verified R2 artifact write must precede D1 strategy JSON compaction',
)

assert.match(retirement, /destructive_step_requires_verified_artifact: true/)
assert.match(retirement, /LEGACY_HOT_DATA_RETIREMENT_CONFIRM_PHRASE/)
assert.match(retirement, /const dryRun = options\.dryRun !== false/)
assert.ok(
  retirement.indexOf('await archiveRows') < retirement.indexOf("deleteLegacyCutoverRows(legacyShadowSource(env), input.table"),
  'archive/readback must precede generic D1 retirement deletes',
)
assert.match(retirement, /prediction_date_inference_forbidden: true/)
assert.match(retirement, /businessDate: 'undated'/)
assert.match(retirement, /preserved_event_types/)
assert.match(retirement, /paper_broker_reconciliation/)
assert.match(retirement, /s12_intraday_structure/)
assert.match(retirement, /allocator_snapshot_staging_orphans/)
assert.match(retirement, /releaseArtifactHardReferencesByOwner/)
assert.match(retirement, /databaseForDataDomain\(env, 'ops'\)/)
assert.match(retirement, /deleteLegacyCutoverRows/)
assert.match(retirement, /writer_state='cutover' AND epoch=\?/)
assert.match(retirement, /legacy_retirement_exact_delete_failed/)
assert.match(retirement, /legacy_retirement_writer_restore_failed/)
assert.match(retirement, /const results = await db\.batch\(statements\)/)
assert.match(retirement, /return keys\.length/)
assert.doesNotMatch(retirement, /deleted_row_count_mismatch/)
assert.ok(
  retirement.indexOf("SET writer_state='open'") < retirement.indexOf('DELETE FROM "${table}"'),
  'cutover source opens only inside the atomic exact-delete batch',
)
assert.ok(
  retirement.indexOf('DELETE FROM "${table}"') < retirement.indexOf("SET writer_state='cutover'"),
  'cutover writer fence must be restored after exact deletes',
)
assert.doesNotMatch(
  retirement.match(/event_type IN \(([^)]+)\)/)?.[1] ?? '',
  /paper_order|paper_position_update|paper_broker_reconciliation|live_execution_shadow|s12_intraday_structure/,
)

assert.match(archive, /canonical_run_heads/)
assert.match(archive, /latest\.status = 'success'/)
assert.match(archive, /canonical_screener_funnel_items/)
assert.match(archive, /target: target\.id/)
assert.match(archive, /strategy_decision_log\.context_id IS NOT NULL/)
assert.match(archive, /strategy_decision_log\.evidence_artifact_id IS NOT NULL/)
assert.match(archive, /cursor\?\.backlog_remaining/)
assert.match(archive, /loadCandidateRows\(targetDb, target, cutoffDate, limitPerTable, minBlobBytes, null\)/)
assert.match(dashboard, /readStockModelSignals\(c\.env, id, signalLimit\)/)
assert.match(predictionsReader, /prediction_date IS NOT NULL/)
assert.doesNotMatch(dashboard, /COALESCE\(prediction_date, substr\(generated_at/)
assert.doesNotMatch(predictionsReader, /COALESCE\(prediction_date, substr\(generated_at/)
// D9 step 4: the scheduled read-only audit root is retired; the task stays manual-only.
const parsedManifest = JSON.parse(manifest)
// The strategy migration cursor completed on 11/07 and its job was deleted; a scheduler sync must not recreate it.
assert.ok(parsedManifest.deleteJobIds.includes('legacy-strategy-evidence-migration'))
assert.ok(!parsedManifest.jobs.some((job: { id?: string }) => job.id === 'legacy-strategy-evidence-migration'))
assert.ok(parsedManifest.deleteJobIds.includes('legacy-hot-data-retirement'))
assert.ok(!parsedManifest.jobs.some((job: { id?: string }) => job.id === 'legacy-hot-data-retirement'))
assert.ok(!parsedManifest.jobs.some((job: { task?: string; query?: string }) => (
  job.task === 'legacy-hot-data-retirement' || /confirm_retirement=/.test(String(job.query ?? ''))
)))
