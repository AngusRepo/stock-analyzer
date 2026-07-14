import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('migration_strategy_discovery_lab_2026_07_11.sql', 'utf8')
const schema = fs.readFileSync('schema.sql', 'utf8')
const migrationLines = migration.trimEnd().split(/\r?\n/)
const schemaLines = schema.split(/\r?\n/)
const labStart = schemaLines.indexOf('-- Multi-LLM Strategy Discovery & Adversarial Audit Lab')
assert(labStart >= 0, 'schema.sql missing exact Lab migration block')
assert.deepEqual(schemaLines.slice(labStart, labStart + migrationLines.length), migrationLines, 'schema.sql Lab block must exactly match standalone migration')

const tables = [
  'input_snapshots','feature_versions','features','strategy_versions','strategies','analysis_runs','workflow_steps',
  'workflow_checkpoints','model_calls','feature_clusters','gap_maps','hypotheses','candidates','candidate_lineage',
  'static_validation_results','audit_issues','cross_examinations','artifacts','codex_imports','strategy_verdicts',
  'candidate_verdicts','issue_verdicts','model_accuracy',
]
for (const table of tables) {
  const marker = `CREATE TABLE IF NOT EXISTS ${table}`
  assert(migration.includes(marker), `migration missing ${table}`)
  assert(schema.includes(marker), `schema missing ${table}`)
}

for (const marker of [
  'idx_analysis_runs_created_at','idx_analysis_runs_status','idx_workflow_steps_run_step','idx_model_calls_run_role',
  'idx_candidates_run_id','idx_audit_issues_run_target','idx_artifacts_run_type','idx_codex_imports_run_id',
]) {
  assert(migration.includes(marker), `migration missing index ${marker}`)
  assert(schema.includes(marker), `schema missing index ${marker}`)
}

for (const forbidden of ['paper_orders','paper_positions','daily_recommendations','model_artifact_registry']) {
  assert(!migration.includes(forbidden), `lab migration must not reference production table ${forbidden}`)
}

assert(migration.includes("source_type IN ('REAL','FIXTURE')"), 'model provenance must distinguish REAL and FIXTURE')
assert(migration.includes('UNIQUE(run_id, idempotency_key)'), 'Codex import POST must be idempotent per run')
