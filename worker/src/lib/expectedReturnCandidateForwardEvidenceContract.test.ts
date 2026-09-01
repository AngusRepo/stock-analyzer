import assert from 'node:assert/strict'
import fs from 'node:fs'

const rootMigration = fs.readFileSync('migrations/0121_expected_return_candidate_forward_evaluations.sql', 'utf8')
const domainMigration = fs.readFileSync('domain-migrations/learning/0035_expected_return_candidate_forward_evaluations.sql', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')
const servingRegistry = fs.readFileSync('src/lib/expectedReturnServingRegistry.ts', 'utf8')
const promotion = fs.readFileSync('src/lib/expectedReturnArtifactPromotion.ts', 'utf8')
const evaluator = fs.readFileSync('../ml-controller/services/expected_return_candidate_forward_evaluator.py', 'utf8')
const lifecycle = fs.readFileSync('../ml-controller/routers/walk_forward.py', 'utf8')

const rootSchema = rootMigration.slice(rootMigration.indexOf('CREATE TABLE'))
const domainSchema = domainMigration.slice(domainMigration.indexOf('CREATE TABLE'))
const normalizeSql = (value: string) => value.replace(/\s+/g, ' ').trim()
assert.equal(normalizeSql(domainSchema), normalizeSql(rootSchema), 'root and learning-domain forward evidence schemas must remain identical')
assert(rootSchema.includes('CHECK(prediction_date > source_run_date)'), 'D1 must reject pre-freeze candidate evidence')
assert(rootSchema.includes('CHECK(label_known_date > prediction_date)'), 'D1 must require a future label-known date')
assert(registry.includes("'expected_return_candidate_forward_evaluations'"), 'forward evidence table must route to learning D1')

assert(evaluator.includes("str(row.get(\"snapshot_date\") or \"\")[:10] > source_date"), 'evaluator must exclude every pre-freeze prediction row')
assert(evaluator.includes("str(row.get(\"label_known_date\") or \"\")[:10] <= business_date"), 'evaluator must use only labels known by the lifecycle cutoff')
assert(evaluator.includes('candidate_artifact_id=? AND model_fingerprint=?'), 'gate aggregation must stay bound to the exact candidate fingerprint')
assert(evaluator.includes('"training_dispatched": False'), 'candidate forward evaluation must never train')

assert(promotion.includes("prospective.schema_version !== 'expected-return-candidate-forward-gate-v1'"), 'promotion must require the prospective gate contract')
assert(promotion.includes('prospective_prediction_not_after_candidate_freeze'), 'promotion must reject pre-freeze prospective ranges')
assert(servingRegistry.includes('FROM expected_return_candidate_forward_evaluations'), 'pointer commit must re-read durable forward evidence')
assert(servingRegistry.includes('invalid_pre_freeze_rows'), 'pointer commit must independently reject pre-freeze rows')
assert(servingRegistry.includes('expected_return_registry_prospective_evidence_mismatch'), 'pointer commit must fail closed on payload/D1 mismatch')
assert(lifecycle.includes('if not req.dry_run and not dependency_retry_required'), 'terminal receipt must be withheld while promotion or OPB closure needs retry')

console.log('expected return candidate forward evidence contract passed')
