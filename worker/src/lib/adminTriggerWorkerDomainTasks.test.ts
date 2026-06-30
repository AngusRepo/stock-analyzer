import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { summarizeMlControllerWarmupTargets } from './adminTriggerWorkerDomainTasks'

const healthy = summarizeMlControllerWarmupTargets({
  targets: {
    predict_batch_v2: { status: 'ok' },
    gnn_graphsage_universal_predict: { status: 'ok' },
    timesfm_universal_predict: { status: 'ok' },
    strategy_similarity_evidence: {
      status: 'ok',
      algorithm_owner: 'ml-service-modal-python',
      kmedoids_pam_preflight_status: 'pass',
    },
  },
})

assert.equal(healthy.ok, true)
assert.match(healthy.summary, /strategy_similarity_evidence=ok/)
assert.match(healthy.summary, /pam=pass/)
assert.match(healthy.summary, /owner=ml-service-modal-python/)

const degraded = summarizeMlControllerWarmupTargets({
  targets: {
    predict_batch_v2: { status: 'ok' },
    strategy_similarity_evidence: {
      status: 'degraded',
      algorithm_owner: 'ml-service-modal-python',
      kmedoids_pam_preflight_status: 'blocked',
    },
  },
})

assert.equal(degraded.ok, false)
assert.match(degraded.summary, /strategy_similarity_evidence=degraded/)
assert.match(degraded.summary, /pam=blocked/)

const malformed = summarizeMlControllerWarmupTargets({ targets: null })
assert.equal(malformed.ok, false)
assert.equal(malformed.summary, 'targets=unknown')

const source = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
assert.match(source, /'strategy-learning': \(\) => enqueueStrategyLearningMaterialization/)
assert.match(source, /type: 'strategy_learning_materialize'/)
assert.match(source, /callback expected/)
assert.match(source, /'audit-json-retention': async/)
assert.match(source, /AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE/)
assert.match(source, /confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE/)

const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
assert.match(triggerRoutes, /'audit-json-retention'/)

const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
assert.match(schedulerPolicy, /'audit-json-retention'/)

const schedulerManifest = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')
assert.match(schedulerManifest, /"id": "audit-json-retention"/)
assert.match(schedulerManifest, /confirm_archive=ARCHIVE_D1_AUDIT_JSON_TO_R2/)
