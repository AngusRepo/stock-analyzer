import { strict as assert } from 'node:assert'
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
