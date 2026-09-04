import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const rootMigration = fs.readFileSync('migrations/0122_expected_return_candidate_preoutcome_evaluations.sql', 'utf8')
const domainMigration = fs.readFileSync('domain-migrations/learning/0038_expected_return_candidate_preoutcome_evaluations.sql', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')
const servingRegistry = fs.readFileSync('src/lib/expectedReturnServingRegistry.ts', 'utf8')
const promotion = fs.readFileSync('src/lib/expectedReturnArtifactPromotion.ts', 'utf8')
const evaluator = fs.readFileSync('../ml-controller/services/expected_return_candidate_forward_evaluator.py', 'utf8')
const lifecycle = fs.readFileSync('../ml-controller/routers/walk_forward.py', 'utf8')

const rootSchema = rootMigration.slice(rootMigration.indexOf('CREATE TABLE'))
const domainSchema = domainMigration.slice(domainMigration.indexOf('CREATE TABLE'))
const normalizeSql = (value: string) => value.replace(/\s+/g, ' ').trim()
assert.equal(normalizeSql(domainSchema), normalizeSql(rootSchema), 'root and learning-domain forward evidence schemas must remain identical')
assert(rootSchema.includes('prediction_date > artifact_trained_until'), 'D1 must reject rows inside the artifact training window')
assert(rootSchema.includes('AND prediction_date >= selection_semantic_floor_date'), 'D1 must reject pre-V5 semantic rows')
assert(rootSchema.includes('label_known_date > prediction_date'), 'D1 must require a future label-known date')
assert(rootSchema.includes('AND label_known_date > source_run_date'), 'D1 must reject outcomes already known at candidate freeze')
assert(registry.includes("'expected_return_candidate_preoutcome_evaluations'"), 'pre-outcome evidence table must route to learning D1')

assert(evaluator.includes("str(row.get(\"snapshot_date\") or \"\")[:10] > evidence_trained_until"), 'evaluator must exclude the artifact training window')
assert(evaluator.includes("str(row.get(\"label_known_date\") or \"\")[:10] > source_date"), 'evaluator must exclude outcomes known at candidate freeze')
assert(evaluator.includes('strategy-semantic-continuous-affinity-v5'), 'evaluator must source the clean-selection floor from canonical V5 eligibility')
assert(evaluator.includes("str(row.get(\"label_known_date\") or \"\")[:10] <= business_date"), 'evaluator must use only labels known by the lifecycle cutoff')
assert(evaluator.includes('candidate_artifact_id=? AND model_fingerprint=?'), 'gate aggregation must stay bound to the exact candidate fingerprint')
assert(evaluator.includes('"training_dispatched": False'), 'candidate forward evaluation must never train')
assert(evaluator.includes('MIN_EVALUABLE_DATES = PRIMARY_MIN_OOS_DATES'), 'prospective maturity must reuse the formal 10 OOS-date floor')
assert(evaluator.includes('selected[owner] = active[-1]'), 'a newer weekly candidate must not reset an active prospective lane')
assert(evaluator.includes('MAX_EVALUABLE_DATES = 30'), 'an inconclusive first review must retain a bounded evidence-extension window')
assert(evaluator.includes('else "PENDING" if maturity_blockers'), 'sub-maturity evidence must remain pending rather than fail quality')
assert(evaluator.includes('else "HOLD"'), 'inconclusive evidence at the first review must continue accumulating rather than fail immediately')
assert(evaluator.includes('offline_admission_not_pass'), 'prospective evaluation must fail closed when any hard offline blocker remains')
assert(evaluator.includes('assess_ev_operational_parity'), 'daily exact-candidate evaluation must independently rebuild parity for immutable legacy packets')
assert(lifecycle.includes('native_rows=native_rows'), 'lifecycle must provide current native rows for daily exact-candidate parity')

assert(promotion.includes("prospective.schema_version !== 'expected-return-candidate-forward-gate-v2'"), 'promotion must require the pre-outcome-lock gate contract')
assert(promotion.includes('prediction_not_after_candidate_trained_until'), 'promotion must reject evidence inside the training window')
assert(promotion.includes('label_known_not_after_candidate_freeze'), 'promotion must reject outcomes known at freeze')
assert(promotion.includes('prediction_before_selection_semantic_floor'), 'promotion must reject evidence before the V5 semantic floor')
assert(servingRegistry.includes('FROM expected_return_candidate_preoutcome_evaluations'), 'pointer commit must re-read durable pre-outcome evidence')
assert(servingRegistry.includes('invalid_pre_training_rows'), 'pointer commit must independently reject training-window rows')
assert(servingRegistry.includes('invalid_label_known_before_freeze_rows'), 'pointer commit must independently reject labels known at freeze')
assert(servingRegistry.includes('expected_return_registry_selection_semantic_floor_mismatch'), 'pointer commit must re-read the canonical V5 semantic floor')
assert(servingRegistry.includes('expected_return_registry_prospective_evidence_mismatch'), 'pointer commit must fail closed on payload/D1 mismatch')
assert(servingRegistry.includes('EXPECTED_RETURN_PROSPECTIVE_MIN_DATES = 10'), 'pointer commit must enforce the exact 10-date prospective contract')
assert(lifecycle.includes('if not req.dry_run and not dependency_retry_required'), 'terminal receipt must be withheld while promotion or OPB closure needs retry')

const db = new DatabaseSync(':memory:')
db.exec(rootMigration)
const insert = db.prepare(`
  INSERT INTO expected_return_candidate_preoutcome_evaluations (
    evaluation_id, candidate_artifact_id, candidate_artifact_checksum,
    model_name, model_version, model_fingerprint, cohort_id, source_run_date,
    artifact_trained_until, selection_semantic_floor_date,
    extension_manifest_checksum, prediction_date, label_known_date,
    sample_count, quality_decision, evidence_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const row = [
  'valid', 'l4:test', 'a'.repeat(64), 'l4_alpha_ev', 'v2', 'b'.repeat(64),
  'cohort', '2026-08-30', '2026-08-18', '2026-08-25',
  'c'.repeat(64), '2026-08-25', '2026-09-01', 30, 'PASS', '{}',
] as const
assert.doesNotThrow(() => insert.run(...row), '8/25 must be legal when trained through 8/18 and its label was unknown at 8/30 freeze')
assert.throws(
  () => insert.run(...row.map((value, index) => index === 0 ? 'pre-semantic' : index === 11 ? '2026-08-24' : value)),
  'pre-V5 8/24 evidence must be rejected',
)
assert.throws(
  () => insert.run(...row.map((value, index) => index === 0 ? 'known-at-freeze' : index === 12 ? '2026-08-29' : value)),
  'a label known before 8/30 freeze must be rejected',
)
db.close()

console.log('expected return candidate forward evidence contract passed')
